'use strict';

const co = require('co');
const assert = require('assert');
const is = require('is-type-of');
const utils = require('../utils');
const logger = require('../logger');
const MixAll = require('../mix_all');
const MQClient = require('../mq_client');
const ClientConfig = require('../client_config');
const ProcessQueue = require('../process_queue');
const PullStatus = require('../consumer/pull_status');
const PullSysFlag = require('../utils/pull_sys_flag');
const ConsumeFromWhere = require('./consume_from_where');
const MessageModel = require('../protocol/message_model');
const ConsumeType = require('../protocol/consume_type');
const ReadOffsetType = require('../store/read_offset_type');
const LocalFileOffsetStore = require('../store/local_file');
// const MessageDecoder = require('../message/message_decoder');
const RemoteBrokerOffsetStore = require('../store/remote_broker');
const AllocateMessageQueueAveragely = require('./rebalance/allocate_message_queue_averagely');

const defaultOptions = {
  logger,
  isBroadcast: false, // 是否是广播模式（默认集群消费模式）
  brokerSuspendMaxTimeMillis: 1000 * 15, // 长轮询模式，Consumer连接在Broker挂起最长时间
  pullTimeDelayMillsWhenException: 3000, // 拉消息异常时，延迟一段时间再拉
  consumerTimeoutMillisWhenSuspend: 1000 * 30, // 长轮询模式，Consumer超时时间（必须要大于brokerSuspendMaxTimeMillis）
  consumerGroup: MixAll.DEFAULT_CONSUMER_GROUP,
  consumeFromWhere: ConsumeFromWhere.CONSUME_FROM_LAST_OFFSET, // Consumer第一次启动时，从哪里开始消费
  /**
   * Consumer第一次启动时，如果回溯消费，默认回溯到哪个时间点，数据格式如下，时间精度秒：
   * 20131223171201
   * 表示2013年12月23日17点12分01秒
   * 默认回溯到相对启动时间的半小时前
   */
  consumeTimestamp: utils.timeMillisToHumanString(Date.now() - 1000 * 60 * 30),
  pullThresholdForQueue: 1000, // 本地队列消息数超过此阀值，开始流控
  pullInterval: 0, // 拉取消息的频率, 如果为了降低拉取速度，可以设置大于0的值
  consumeMessageBatchMaxSize: 1, // 消费一批消息，最大数
  pullBatchSize: 32, // 拉消息，一次拉多少条
  postSubscriptionWhenPull: true, // 是否每次拉消息时，都上传订阅关系
  allocateMessageQueueStrategy: new AllocateMessageQueueAveragely(), // 队列分配算法，应用可重写
};

class MQPushConsumer extends ClientConfig {
  constructor(options) {
    assert(options && options.consumerGroup, '[MQPushConsumer] options.consumerGroup is required');
    super(Object.assign({ initMethod: 'init' }, defaultOptions, options));

    // @example:
    // pullFromWhichNodeTable => {
    //   '[topic="TEST_TOPIC", brokerName="qdinternet-03", queueId="1"]': 0
    // }
    this._pullFromWhichNodeTable = new Map();
    this._subscriptions = new Map();
    this._topicSubscribeInfoTable = new Map();
    this._processQueueTable = new Map();
    this._inited = false;

    if (this.messageModel === MessageModel.CLUSTERING) {
      this.changeInstanceNameToPID();
    }

    this._mqClient = MQClient.getAndCreateMQClient(this);
    this._offsetStore = this.options.isBroadcast ?
      new LocalFileOffsetStore(this._mqClient, this.consumerGroup) :
      new RemoteBrokerOffsetStore(this._mqClient, this.consumerGroup);

    this._mqClient.on('error', err => this._error(err));
    this._offsetStore.on('error', err => this._error(err));
  }

  get logger() {
    return this.options.logger;
  }

  get subscriptions() {
    return this._subscriptions;
  }

  get consumerGroup() {
    return this.options.consumerGroup;
  }

  get messageModel() {
    return this.options.isBroadcast ? MessageModel.BROADCASTING : MessageModel.CLUSTERING;
  }

  get consumeType() {
    return ConsumeType.CONSUME_PASSIVELY;
  }

  get consumeFromWhere() {
    return this.options.consumeFromWhere;
  }

  get allocateMessageQueueStrategy() {
    return this.options.allocateMessageQueueStrategy;
  }

  * init() {
    this._mqClient.registerConsumer(this.consumerGroup, this);
    yield this._mqClient.ready();
    yield this._offsetStore.load();
    this.logger.info('[mq:consumer] consumer started');
    this._inited = true;
  }

  /**
   * close the consumer
   * @return {Promise} promise
   */
  close() {
    return co(function* () {
      this._inited = false;
      this._pullFromWhichNodeTable.clear();
      this._subscriptions.clear();
      this._topicSubscribeInfoTable.clear();
      this._processQueueTable.clear();

      yield this.persistConsumerOffset();
      yield this._mqClient.unregisterConsumer(this.consumerGroup);
      yield this._mqClient.close();
      this.removeAllListeners();
      this.logger.info('[mq:consumer] consumer closed');
    }.bind(this));
  }

  /**
   * subscribe
   * @param {String} topic - topic
   * @param {String} subExpression - tag
   * @return {void}
   */
  subscribe(topic, subExpression) {
    const subscriptionData = this.buildSubscriptionData(this.consumerGroup, topic, subExpression);
    this.subscriptions.set(topic, subscriptionData);

    if (this._inited) {
      co(function* () {
        yield this._mqClient.updateAllTopicRouterInfo();
        yield this._mqClient.sendHeartbeatToAllBroker();
        yield this._mqClient.doRebalance();
      }.bind(this)).catch(err => this._error(err));
    }
  }

  /**
   * construct subscription data
   * @param {String} consumerGroup - consumer group name
   * @param {String} topic - topic
   * @param {String} subString - tag
   * @return {Object} subscription
   */
  buildSubscriptionData(consumerGroup, topic, subString) {
    const subscriptionData = {
      topic,
      subString,
      classFilterMode: false,
      tagsSet: [],
      codeSet: [],
      subVersion: Date.now(),
    };
    if (is.nullOrUndefined(subString) || subString === '*' || subString === '') {
      subscriptionData.subString = '*';
    } else {
      const tags = subString.split('||');
      if (tags && tags.length) {
        for (let tag of tags) {
          tag = tag.trim();
          if (tag) {
            subscriptionData.tagsSet.push(tag);
            subscriptionData.codeSet.push(utils.hashCode(tag));
          }
        }
      } else {
        throw new Error('[mq:consumer] subString split error');
      }
    }
    return subscriptionData;
  }

  * persistConsumerOffset() {
    const mqs = [];
    for (const key of this._processQueueTable.keys()) {
      if (this._processQueueTable.get(key)) {
        mqs.push(this._processQueueTable.get(key).messageQueue);
      }
    }
    yield this._offsetStore.persistAll(mqs);
  }

  /**
   * pull message from queue
   * @param {MessageQueue} messageQueue - message queue
   * @return {void}
   */
  pullMessageQueue(messageQueue) {
    co(function* () {
      while (this._processQueueTable.has(messageQueue.key)) {
        try {
          yield this.executePullRequestImmediately(messageQueue);
          yield sleep(this.options.pullInterval);
        } catch (err) {
          if (this._inited) {
            err.name = 'MQConsumerPullMessageError';
            err.message = `[mq:consumer] pull message for queue: ${messageQueue.key}, occurred error: ${err.message}`;
            this.logger.error(err);
            yield sleep(this.options.pullTimeDelayMillsWhenException);
          }
        }
      }
    }.bind(this));
  }

  /**
   * execute pull message immediately
   * @param {MessageQueue} messageQueue - messageQueue
   * @return {void}
   */
  * executePullRequestImmediately(messageQueue) {
    // close or queue removed
    if (!this._processQueueTable.has(messageQueue.key)) {
      return;
    }
    const pullRequest = this._processQueueTable.get(messageQueue.key);
    const processQueue = pullRequest.processQueue;
    // queue droped
    if (processQueue.droped) {
      return;
    }
    processQueue.lastPullTimestamp = Date.now();

    const subscriptionData = this.subscriptions.get(messageQueue.topic);
    if (!subscriptionData) {
      this.logger.warn('[mq:consumer] execute pull request, but subscriptionData not found, topic: %s, queueId: %s', messageQueue.topic, messageQueue.queueId);
      yield sleep(this.options.pullTimeDelayMillsWhenException);
      return;
    }

    let commitOffset = 0;
    const subExpression = this.options.postSubscriptionWhenPull ? subscriptionData.subString : null;
    const subVersion = subscriptionData.subVersion;

    // cluster model
    if (MessageModel.CLUSTERING === this.messageModel) {
      const offset = yield this._offsetStore.readOffset(pullRequest.messageQueue, ReadOffsetType.READ_FROM_MEMORY);
      if (offset) {
        commitOffset = offset;
      }
    }
    const pullResult = yield this.pullKernelImpl(messageQueue, subExpression, subVersion, pullRequest.nextOffset, commitOffset);
    this.updatePullFromWhichNode(messageQueue, pullResult.suggestWhichBrokerId);
    const originOffset = pullRequest.nextOffset;
    // update next pull offset
    pullRequest.nextOffset = pullResult.nextBeginOffset;

    switch (pullResult.pullStatus) {
      case PullStatus.FOUND:
        {
          let msgList = pullResult.msgFoundList;
          this.logger.info('[mq:consumer] new messages found, size: %d', msgList.length);
          if (subscriptionData.tagsSet && subscriptionData.tagsSet.length && !subscriptionData.classFilterMode) {
            msgList = msgList.filter(function(msg) {
              if (msg.tags && subscriptionData.tagsSet.indexOf(msg.tags) >= 0) {
                return true;
              }
              return false;
            });
          }
          this.logger.info('[mq:consumer] after filter by tags %d messages remaining.', msgList.length);
          if (msgList && msgList.length) {
            // todo: long ?
            const firstMsgOffset = Number(msgList[0].queueOffset);
            const lastMsgOffset = Number(msgList[msgList.length - 1].queueOffset);

            yield new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                reject(new Error(`Message process timeout for topic: ${subscriptionData.topic}, from ${firstMsgOffset} to ${lastMsgOffset}.`));
              }, 3000);

              // emit message event
              this.emit('message', msgList, () => {
                resolve();
                clearTimeout(timer);
              });
            });

            // update offset
            this._offsetStore.updateOffset(messageQueue, lastMsgOffset + 1);
            this.logger.info('[mq:consumer] process message successfully for topic: %s at queue: %s from %d to %d', subscriptionData.topic, messageQueue.queueId, firstMsgOffset, lastMsgOffset);
          }
          break;
        }
      case PullStatus.NO_NEW_MSG:
      case PullStatus.NO_MATCHED_MSG:
        this.logger.debug('[mq:consumer] no new message for topic: %s at message queue => %s', subscriptionData.topic, messageQueue.key);
        this.correctTagsOffset(pullRequest);
        break;
      case PullStatus.OFFSET_ILLEGAL:
        this.logger.warn('[mq:consumer] the pull request offset illegal, message queue => %s, the originOffset => %j, pullResult => %j', messageQueue.key, originOffset, pullResult);
        pullRequest.processQueue.droped = true;
        yield sleep(10000);
        this._offsetStore.updateOffset(messageQueue, pullRequest.nextOffset);
        yield this._offsetStore.persist(messageQueue);
        yield this.removeProcessQueue(messageQueue);
        break;
      default:
        break;
    }
    // update pull request
    this._processQueueTable.set(messageQueue.key, pullRequest);
  }

  * pullKernelImpl(messageQueue, subExpression, subVersion, offset, commitOffset) {
    let sysFlag = PullSysFlag.buildSysFlag( //
      commitOffset > 0, // commitOffset
      true, // suspend
      !!subExpression, // subscription
      false // class filter
    );
    const result = yield this.findBrokerAddress(messageQueue);
    if (!result) {
      throw new Error(`The broker[${messageQueue.brokerName}] not exist`);
    }

    // Slave不允许实时提交消费进度，可以定时提交
    if (result.slave) {
      sysFlag = PullSysFlag.clearCommitOffsetFlag(sysFlag);
    }

    const requestHeader = {
      consumerGroup: this.consumerGroup,
      topic: messageQueue.topic,
      queueId: messageQueue.queueId,
      queueOffset: offset,
      maxMsgNums: this.options.pullBatchSize,
      sysFlag,
      commitOffset,
      suspendTimeoutMillis: this.options.brokerSuspendMaxTimeMillis,
      subscription: subExpression,
      subVersion,
    };
    return yield this._mqClient.pullMessage(result.brokerAddr, requestHeader, this.options.consumerTimeoutMillisWhenSuspend);
  }

  * findBrokerAddress(messageQueue) {
    let findBrokerResult = this._mqClient.findBrokerAddressInSubscribe(
      messageQueue.brokerName, this.recalculatePullFromWhichNode(messageQueue), false);

    if (!findBrokerResult) {
      yield this._mqClient.updateTopicRouteInfoFromNameServer(messageQueue.topic);
      findBrokerResult = this._mqClient.findBrokerAddressInSubscribe(
        messageQueue.brokerName, this.recalculatePullFromWhichNode(messageQueue), false);
    }
    return findBrokerResult;
  }

  recalculatePullFromWhichNode(messageQueue) {
    // @example:
    // pullFromWhichNodeTable => {
    //   '[topic="TEST_TOPIC", brokerName="qdinternet-03", queueId="1"]': 0
    // }
    return this._pullFromWhichNodeTable.get(messageQueue.key) || MixAll.MASTER_ID;
  }

  correctTagsOffset(pullRequest) {
    this._offsetStore.updateOffset(pullRequest.messageQueue, pullRequest.nextOffset, true);
  }

  updatePullFromWhichNode(messageQueue, brokerId) {
    this._pullFromWhichNodeTable.set(messageQueue.key, brokerId);
  }

  /**
   * update subscription data
   * @param {String} topic - topic
   * @param {Array} info - info
   * @return {void}
   */
  updateTopicSubscribeInfo(topic, info) {
    if (this._subscriptions.has(topic)) {
      this._topicSubscribeInfoTable.set(topic, info);
    }
  }

  /**
   * whether need update
   * @param {String} topic - topic
   * @return {Boolean} need update?
   */
  isSubscribeTopicNeedUpdate(topic) {
    if (this._subscriptions && this._subscriptions.has(topic)) {
      return !this._topicSubscribeInfoTable.has(topic);
    }
    return false;
  }

  /**
   * rebalance
   * @return {void}
   */
  * doRebalance() {
    for (const topic of this.subscriptions.keys()) {
      yield this.rebalanceByTopic(topic);
    }
  }

  * rebalanceByTopic(topic) {
    this.logger.info('[mq:consumer] rebalanceByTopic: %s, messageModel: %s', topic, this.messageModel);
    const mqSet = this._topicSubscribeInfoTable.get(topic); // messageQueue list
    if (!mqSet || !mqSet.length) {
      this.logger.warn('[mq:consumer] doRebalance, %s, but the topic[%s] not exist.', this.consumerGroup, topic);
      return;
    }

    let changed;
    if (this.options.isBroadcast) {
      changed = yield this.updateProcessQueueTableInRebalance(topic, mqSet);
    } else {
      const cidAll = yield this._mqClient.findConsumerIdList(topic, this.consumerGroup);
      this.logger.info('[mq:consumer] rebalance topic: %s, with consumer ids: %j', topic, cidAll);
      if (cidAll && cidAll.length) {
        // 排序
        mqSet.sort(compare);
        cidAll.sort();

        const allocateResult = this.allocateMessageQueueStrategy.allocate(this.consumerGroup, this._mqClient.clientId, mqSet, cidAll);
        this.logger.info('[mq:consumer] allocate queue for group: %s, clientId: %s, result: %j', this.consumerGroup, this._mqClient.clientId, allocateResult);
        changed = yield this.updateProcessQueueTableInRebalance(topic, allocateResult);
      }
    }
    if (changed) {
      this.logger.info('[mq:consumer] do rebalance and message queue changed, topic: %s, mqSet: %j', topic, mqSet);
      this.emit('messageQueueChanged', topic, mqSet);
    }
  }

  /**
   * update process queue
   * @param {String} topic - topic
   * @param {Array} mqSet - message queue set
   * @return {void}
   */
  * updateProcessQueueTableInRebalance(topic, mqSet) {
    let changed = false;
    // delete unnecessary queue
    for (const key of this._processQueueTable.keys()) {
      const obj = this._processQueueTable.get(key);
      if (!obj) {
        this._processQueueTable.delete(key);
      }

      const messageQueue = obj.messageQueue;
      const processQueue = obj.processQueue;

      if (topic === messageQueue.topic) {
        // not found in mqSet, that means the process queue is unnecessary.
        if (!mqSet.some(mq => mq.key === messageQueue.key)) {
          processQueue.droped = true;
          if (yield this.removeUnnecessaryMessageQueue(messageQueue, processQueue)) {
            changed = true;
            this._processQueueTable.delete(key);
          }
        }
      } else if (processQueue.isPullExpired && this.consumeType === ConsumeType.CONSUME_PASSIVELY) {
        processQueue.droped = true;
        if (yield this.removeUnnecessaryMessageQueue(messageQueue, processQueue)) {
          changed = true;
          this._processQueueTable.delete(key);
        }
      }
    }

    for (const messageQueue of mqSet) {
      if (this._processQueueTable.has(messageQueue.key)) {
        continue;
      }

      const nextOffset = yield this.computePullFromWhere(messageQueue);
      // double check
      if (this._processQueueTable.has(messageQueue.key)) {
        continue;
      }

      if (nextOffset >= 0) {
        const processQueue = new ProcessQueue();
        changed = true;
        this._processQueueTable.set(messageQueue.key, {
          messageQueue,
          processQueue,
          nextOffset,
        });
        // start to pull this queue;
        this.pullMessageQueue(messageQueue);

        this.logger.info('[mq:consumer] doRebalance, %s, add a new messageQueue, %j, its nextOffset: %s', this.consumerGroup, messageQueue, nextOffset);
      } else {
        this.logger.warn('[mq:consumer] doRebalance, %s, new messageQueue, %j, has invalid nextOffset: %s', this.consumerGroup, messageQueue, nextOffset);
      }
    }

    return changed;
  }

  /**
   * compute consume offset
   * @param {MessageQueue} messageQueue - message queue
   * @return {Number} offset
   */
  * computePullFromWhere(messageQueue) {
    try {
      const lastOffset = yield this._offsetStore.readOffset(messageQueue, ReadOffsetType.READ_FROM_STORE);
      this.logger.info('[mq:consumer] read lastOffset => %s from store, topic="%s", brokerName="%s", queueId="%s"', lastOffset, messageQueue.topic, messageQueue.brokerName, messageQueue.queueId);

      let result = -1;
      switch (this.consumeFromWhere) {
        case ConsumeFromWhere.CONSUME_FROM_LAST_OFFSET_AND_FROM_MIN_WHEN_BOOT_FIRST:
        case ConsumeFromWhere.CONSUME_FROM_MIN_OFFSET:
        case ConsumeFromWhere.CONSUME_FROM_MAX_OFFSET:
        case ConsumeFromWhere.CONSUME_FROM_LAST_OFFSET:
          // 第二次启动，根据上次的消费位点开始消费
          if (lastOffset >= 0) {
            result = lastOffset;
          } else if (lastOffset === -1) { // 第一次启动，没有记录消费位点
            // 重试队列则从队列头部开始
            if (messageQueue.topic.indexOf(MixAll.RETRY_GROUP_TOPIC_PREFIX) === 0) {
              result = 0;
            } else { // 正常队列则从队列尾部开始
              return yield this._mqClient.maxOffset(messageQueue);
            }
          }
          break;
        case ConsumeFromWhere.CONSUME_FROM_FIRST_OFFSET:
          // 第二次启动，根据上次的消费位点开始消费
          if (lastOffset >= 0) {
            result = lastOffset;
          } else {
            result = 0;
          }
          break;
        case ConsumeFromWhere.CONSUME_FROM_TIMESTAMP:
          // 第二次启动，根据上次的消费位点开始消费
          if (lastOffset >= 0) {
            result = lastOffset;
          } else if (lastOffset === -1) { // 第一次启动，没有记录消费为点
            // 重试队列则从队列尾部开始
            if (messageQueue.topic.indexOf(MixAll.RETRY_GROUP_TOPIC_PREFIX) === 0) {
              return yield this._mqClient.maxOffset(messageQueue);
            }
            // 正常队列则从指定时间点开始
            // 时间点需要参数配置
            const timestamp = utils.parseDate(this.options.consumeTimestamp).getTime();
            return yield this._mqClient.searchOffset(messageQueue, timestamp);
          }
          break;
        default:
          break;
      }
      this.logger.info('[mq:consumer] computePullFromWhere() messageQueue => %s should read from offset: %s and lastOffset: %s', messageQueue.key, result, lastOffset);
      return result;
    } catch (err) {
      err.mesasge = 'computePullFromWhere() occurred an exception, ' + err.mesasge;
      this.logger.error(err);
      return -1;
    }
  }

  /**
   * 移除消费队列
   * @param {MessageQueue} messageQueue - message queue
   * @return {void}
   */
  * removeProcessQueue(messageQueue) {
    const processQueue = this._processQueueTable.get(messageQueue.key);
    this._processQueueTable.delete(messageQueue.key);
    if (processQueue) {
      const droped = processQueue.droped;
      processQueue.droped = true;
      yield this.removeUnnecessaryMessageQueue(messageQueue, processQueue);
      this.logger.info('[mq:consumer] Fix Offset, %s, remove unnecessary messageQueue, %j Droped: %s', this.consumerGroup, messageQueue, droped);
    }
  }

  /**
   * remove unnecessary queue
   * @param {MessageQueue} messageQueue - message queue
   * @return {Boolean} success or not
   */
  * removeUnnecessaryMessageQueue(messageQueue) {
    yield this._offsetStore.persist(messageQueue);
    this._offsetStore.removeOffset(messageQueue);
    // todo: consume later ？
    return true;
  }

  // * viewMessage(msgId) {
  //   const info = MessageDecoder.decodeMessageId(msgId);
  //   return yield this._mqClient.viewMessage(info.address, Number(info.offset.toString()), 3000);
  // }

  _error(err) {
    setImmediate(() => {
      err.message = 'MQPushConsumer occurred an error' + err.message;
      this.emit('error', err);
    });
  }

  on(event, listener) {
    let newListener = listener;
    if (event === 'message' && is.function(listener) && listener.length === 1) {
      newListener = (message, done) => {
        listener(message);
        done();
      };
      newListener.__oldListener = listener;
    }
    return super.on(event, newListener);
  }

  once(event, listener) {
    let newListener = listener;
    if (event === 'message' && is.function(listener) && listener.length === 1) {
      newListener = (message, done) => {
        listener(message);
        done();
      };
      newListener.__oldListener = listener;
    }
    return super.once(event, newListener);
  }

  removeListener(event, listener) {
    let newListener = listener;
    if (event === 'message' && is.function(listener) && listener.length === 1) {
      const listeners = this.listeners('message');
      for (let i = 0, len = listeners.length; i < len; i++) {
        if (listeners[i].__oldListener === listener) {
          newListener = listeners[i];
          break;
        }
      }
    }
    return super.removeListener(event, newListener);
  }
}

module.exports = MQPushConsumer;

// Helper
// ------------------
function compare(mqA, mqB) {
  if (mqA.topic === mqB.topic) {
    if (mqA.brokerName === mqB.brokerName) {
      return mqA.queueId - mqB.queueId;
    }
    return mqA.brokerName > mqB.brokerName ? 1 : -1;
  }
  return mqA.topic > mqB.topic ? 1 : -1;
}

function sleep(interval) {
  return callback => {
    if (interval <= 0) {
      setImmediate(callback);
    } else {
      setTimeout(callback, interval);
    }
  };
}
