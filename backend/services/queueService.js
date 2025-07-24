const Queue = require('bull');
const redisClient = require('../utils/redisClient');

class QueueService {
  constructor() {
    this.redisConfig = {
      redis: {
        port: process.env.REDIS_PORT || 6379,
        host: process.env.REDIS_HOST || 'localhost',
        retryDelayOnFailover: 100,
        enableOfflineQueue: true, // 연결 끊김 시 큐 유지
        maxRetriesPerRequest: 3,
        lazyConnect: true // 필요할 때만 연결
      }
    };

    this.queues = null;
    this.isInitialized = false;
  }

  // 비동기 초기화
  async initialize() {
    if (this.isInitialized) {
      console.log('⚠️  큐 서비스가 이미 초기화되었습니다.');
      return;
    }

    try {
      console.log('📋 큐 시스템 초기화 중...');
      this.queues = this.initializeQueues();
      this.setupProcessors();
      this.isInitialized = true;
      console.log('✅ 큐 시스템 초기화 완료');
    } catch (error) {
      console.error('❌ 큐 시스템 초기화 실패:', error);
      throw error;
    }
  }

  // 큐 초기화
  initializeQueues() {
    return {
      // 메시지 처리 큐 (높은 우선순위)
      messageQueue: new Queue('message processing', this.redisConfig),
      
      // 파일 처리 큐 (중간 우선순위)
      fileQueue: new Queue('file processing', this.redisConfig),
      
      // AI 처리 큐 (낮은 우선순위, 비용 관리)
      aiQueue: new Queue('ai processing', this.redisConfig),
      
      // 알림 큐 (높은 우선순위)
      notificationQueue: new Queue('notification', this.redisConfig),
      
      // 이메일 큐 (낮은 우선순위)
      emailQueue: new Queue('email', this.redisConfig),
      
      // 데이터 정리 큐 (매우 낮은 우선순위)
      cleanupQueue: new Queue('data cleanup', this.redisConfig),
      
      // 통계 집계 큐 (낮은 우선순위)
      analyticsQueue: new Queue('analytics', this.redisConfig)
    };
  }

  // 프로세서 설정
  setupProcessors() {
    // 메시지 처리 (동시 처리 50개)
    this.queues.messageQueue.process(50, async (job) => {
      return await this.processMessage(job.data);
    });

    // 파일 처리 (동시 처리 10개 - I/O 집약적)
    this.queues.fileQueue.process(10, async (job) => {
      return await this.processFile(job.data);
    });

    // AI 처리 (동시 처리 5개 - API 제한)
    this.queues.aiQueue.process(5, async (job) => {
      return await this.processAI(job.data);
    });

    // 알림 처리 (동시 처리 20개)
    this.queues.notificationQueue.process(20, async (job) => {
      return await this.processNotification(job.data);
    });

    // 이메일 처리 (동시 처리 5개)
    this.queues.emailQueue.process(5, async (job) => {
      return await this.processEmail(job.data);
    });

    // 데이터 정리 (동시 처리 1개)
    this.queues.cleanupQueue.process(1, async (job) => {
      return await this.processCleanup(job.data);
    });

    // 통계 집계 (동시 처리 3개)
    this.queues.analyticsQueue.process(3, async (job) => {
      return await this.processAnalytics(job.data);
    });

    this.setupErrorHandlers();
    this.setupProgressTracking();
  }

  // 메시지 처리
  async processMessage(data) {
    const { roomId, message, sender, type } = data;
    
    try {
      const Message = require('../models/Message');
      
      // 데이터베이스에 저장
      const savedMessage = await Message.create({
        room: roomId,
        content: message.content,
        sender: sender.id,
        type: type || 'text',
        timestamp: new Date(),
        mentions: message.mentions || [],
        metadata: message.metadata || {}
      });

      // 실시간 브로드캐스트
      const io = require('../server').io;
      if (io) {
        const socketClusterService = require('./socketClusterService');
        await socketClusterService.optimizedBroadcast(io, roomId, 'message', {
          ...savedMessage.toJSON(),
          sender: {
            _id: sender.id,
            name: sender.name,
            profileImage: sender.profileImage
          }
        });
      }

      // 캐시 무효화
      const cacheService = require('./cacheService');
      await cacheService.invalidateRoomCache(roomId);

      return { success: true, messageId: savedMessage._id };
    } catch (error) {
      console.error('Message processing error:', error);
      throw error;
    }
  }

  // 파일 처리
  async processFile(data) {
    const { fileId, userId, roomId, originalname, mimetype } = data;
    
    try {
      // 파일 메타데이터 처리
      const File = require('../models/File');
      const file = await File.findById(fileId);
      
      if (!file) {
        throw new Error('File not found');
      }

      // 썸네일 생성 (이미지/비디오)
      if (mimetype.startsWith('image/') || mimetype.startsWith('video/')) {
        await this.generateThumbnail(file);
      }

      // 바이러스 스캔 (실제 구현에서는 외부 서비스 연동)
      await this.scanFile(file);

      // 파일 메시지 생성
      await this.queues.messageQueue.add('file-message', {
        roomId,
        message: { content: `파일을 공유했습니다: ${originalname}` },
        sender: { id: userId },
        type: 'file',
        fileId: fileId
      }, {
        priority: 5 // 일반 메시지보다 낮은 우선순위
      });

      return { success: true, fileId };
    } catch (error) {
      console.error('File processing error:', error);
      throw error;
    }
  }

  // AI 처리
  async processAI(data) {
    const { message, roomId, aiType, userId } = data;
    
    try {
      const aiService = require('./aiService');
      
      // AI 응답 생성
      const response = await aiService.generateResponse(message, aiType, {
        onStart: () => console.log(`🤖 AI ${aiType} processing started`),
        onProgress: (progress) => console.log(`🤖 AI progress: ${progress}%`),
        onComplete: () => console.log(`🤖 AI ${aiType} processing completed`)
      });

      // AI 메시지를 메시지 큐에 추가
      await this.queues.messageQueue.add('ai-message', {
        roomId,
        message: { content: response },
        sender: null,
        type: 'ai',
        aiType: aiType
      }, {
        priority: 3 // 높은 우선순위
      });

      return { success: true, response };
    } catch (error) {
      console.error('AI processing error:', error);
      throw error;
    }
  }

  // 알림 처리
  async processNotification(data) {
    const { userId, type, message, metadata } = data;
    
    try {
      // 사용자 알림 설정 확인
      const User = require('../models/User');
      const user = await User.findById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }

      // Socket.IO로 실시간 알림
      const io = require('../server').io;
      if (io) {
        const userSocket = await this.findUserSocket(io, userId);
        if (userSocket) {
          userSocket.emit('notification', {
            type,
            message,
            metadata,
            timestamp: new Date()
          });
        }
      }

      // 이메일 알림이 필요한 경우
      if (this.shouldSendEmail(type, user.notificationSettings)) {
        await this.queues.emailQueue.add('notification-email', {
          to: user.email,
          subject: this.getEmailSubject(type),
          message,
          metadata
        }, {
          delay: 5000 // 5초 후 발송 (즉시 확인할 수 있도록)
        });
      }

      return { success: true };
    } catch (error) {
      console.error('Notification processing error:', error);
      throw error;
    }
  }

  // 이메일 처리
  async processEmail(data) {
    const { to, subject, message, metadata } = data;
    
    try {
      // 실제 구현에서는 SendGrid, AWS SES 등 사용
      console.log(`📧 Sending email to ${to}: ${subject}`);
      
      // 이메일 발송 로직
      await this.sendEmail(to, subject, message, metadata);
      
      return { success: true };
    } catch (error) {
      console.error('Email processing error:', error);
      throw error;
    }
  }

  // 데이터 정리 처리
  async processCleanup(data) {
    const { type, olderThan } = data;
    
    try {
      let result = {};
      
      switch (type) {
        case 'old_messages':
          result = await this.cleanupOldMessages(olderThan);
          break;
        case 'inactive_sessions':
          result = await this.cleanupInactiveSessions(olderThan);
          break;
        case 'temp_files':
          result = await this.cleanupTempFiles(olderThan);
          break;
        case 'cache':
          result = await this.cleanupCache();
          break;
        default:
          throw new Error(`Unknown cleanup type: ${type}`);
      }
      
      console.log(`🧹 Cleanup completed for ${type}:`, result);
      return { success: true, result };
    } catch (error) {
      console.error('Cleanup processing error:', error);
      throw error;
    }
  }

  // 통계 집계 처리
  async processAnalytics(data) {
    const { type, timeRange, roomId, userId } = data;
    
    try {
      let result = {};
      
      switch (type) {
        case 'message_stats':
          result = await this.calculateMessageStats(timeRange, roomId);
          break;
        case 'user_activity':
          result = await this.calculateUserActivity(timeRange, userId);
          break;
        case 'room_popularity':
          result = await this.calculateRoomPopularity(timeRange);
          break;
        default:
          throw new Error(`Unknown analytics type: ${type}`);
      }
      
      // 결과를 캐시에 저장
      const cacheService = require('./cacheService');
      await cacheService.cacheStats(`analytics:${type}:${timeRange}`, result, 3600);
      
      return { success: true, result };
    } catch (error) {
      console.error('Analytics processing error:', error);
      throw error;
    }
  }

  // 에러 핸들러 설정
  setupErrorHandlers() {
    Object.entries(this.queues).forEach(([name, queue]) => {
      queue.on('failed', (job, err) => {
        console.error(`❌ Queue ${name} job ${job.id} failed:`, err.message);
        
        // 중요한 작업은 재시도
        if (this.shouldRetry(name, job.attemptsMade)) {
          console.log(`🔄 Retrying job ${job.id} (attempt ${job.attemptsMade + 1})`);
        }
      });

      queue.on('stalled', (job) => {
        console.warn(`⏰ Queue ${name} job ${job.id} stalled`);
      });

      queue.on('completed', (job, result) => {
        console.log(`✅ Queue ${name} job ${job.id} completed`);
      });
    });
  }

  // 진행 상황 추적
  setupProgressTracking() {
    Object.entries(this.queues).forEach(([name, queue]) => {
      queue.on('progress', (job, progress) => {
        console.log(`📊 Queue ${name} job ${job.id} progress: ${progress}%`);
      });
    });
  }

  // 작업 추가 메서드들
  async addMessage(roomId, message, sender, options = {}) {
    return await this.queues.messageQueue.add('process-message', {
      roomId,
      message,
      sender,
      type: options.type || 'text'
    }, {
      priority: options.priority || 10,
      delay: options.delay || 0,
      attempts: 3,
      backoff: 'exponential'
    });
  }

  async addFileProcessing(fileData, options = {}) {
    return await this.queues.fileQueue.add('process-file', fileData, {
      priority: options.priority || 5,
      attempts: 2,
      backoff: 'fixed'
    });
  }

  async addAIRequest(message, roomId, aiType, userId, options = {}) {
    return await this.queues.aiQueue.add('process-ai', {
      message,
      roomId,
      aiType,
      userId
    }, {
      priority: options.priority || 1,
      attempts: 1, // AI 요청은 재시도하지 않음 (비용 때문에)
      timeout: 30000 // 30초 타임아웃
    });
  }

  async addNotification(userId, type, message, metadata = {}, options = {}) {
    return await this.queues.notificationQueue.add('send-notification', {
      userId,
      type,
      message,
      metadata
    }, {
      priority: options.priority || 8,
      attempts: 2
    });
  }

  // 스케줄링된 작업들
  scheduleCleanupTasks() {
    // 매일 자정에 오래된 메시지 정리
    this.queues.cleanupQueue.add('cleanup-old-messages', {
      type: 'old_messages',
      olderThan: 30 * 24 * 60 * 60 * 1000 // 30일
    }, {
      repeat: { cron: '0 0 * * *' }, // 매일 자정
      removeOnComplete: 1,
      removeOnFail: 1
    });

    // 매시간 비활성 세션 정리
    this.queues.cleanupQueue.add('cleanup-sessions', {
      type: 'inactive_sessions',
      olderThan: 24 * 60 * 60 * 1000 // 24시간
    }, {
      repeat: { cron: '0 * * * *' }, // 매시간
      removeOnComplete: 1,
      removeOnFail: 1
    });

    // 매주 통계 집계
    this.queues.analyticsQueue.add('weekly-analytics', {
      type: 'room_popularity',
      timeRange: '7d'
    }, {
      repeat: { cron: '0 0 * * 0' }, // 매주 일요일 자정
      removeOnComplete: 5,
      removeOnFail: 1
    });
  }

  // 큐 상태 모니터링
  async getQueueStats() {
    const stats = {};
    
    for (const [name, queue] of Object.entries(this.queues)) {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        queue.getWaiting(),
        queue.getActive(),
        queue.getCompleted(),
        queue.getFailed(),
        queue.getDelayed()
      ]);

      stats[name] = {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: delayed.length
      };
    }
    
    return stats;
  }

  // 헬퍼 메서드들
  shouldRetry(queueName, attempts) {
    const retryLimits = {
      messageQueue: 3,
      fileQueue: 2,
      aiQueue: 1,
      notificationQueue: 2,
      emailQueue: 3,
      cleanupQueue: 1,
      analyticsQueue: 2
    };
    
    return attempts < (retryLimits[queueName] || 1);
  }

  async findUserSocket(io, userId) {
    const sockets = await io.fetchSockets();
    return sockets.find(socket => socket.user?.id === userId);
  }

  shouldSendEmail(notificationType, userSettings) {
    // 사용자 알림 설정에 따라 결정
    const emailTypes = ['mention', 'direct_message', 'room_invite'];
    return emailTypes.includes(notificationType);
  }

  getEmailSubject(type) {
    const subjects = {
      mention: '채팅에서 언급되었습니다',
      direct_message: '새 메시지가 도착했습니다',
      room_invite: '채팅방에 초대되었습니다'
    };
    return subjects[type] || '새 알림';
  }

  // 정리 작업
  async cleanup() {
    const closePromises = Object.values(this.queues).map(queue => queue.close());
    await Promise.all(closePromises);
    console.log('🧹 All queues closed');
  }
}

module.exports = new QueueService(); 