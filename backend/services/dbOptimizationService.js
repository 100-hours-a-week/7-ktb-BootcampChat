const mongoose = require('mongoose');
const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const cacheService = require('./cacheService');

class DBOptimizationService {
  constructor() {
    this.setupConnectionPool();
    this.setupQueryOptimization();
  }

  // MongoDB 연결 풀 최적화
  setupConnectionPool() {
    // 연결 풀 설정 최적화
    mongoose.connection.on('connected', () => {
      console.log('✅ MongoDB connection pool optimized');
      
      // 연결 풀 모니터링
      setInterval(() => {
        const stats = mongoose.connection.db.serverConfig.s.pool;
        if (stats) {
          console.log(`📊 DB Pool - Active: ${stats.totalConnectionCount}, Available: ${stats.availableConnectionCount}`);
        }
      }, 60000); // 1분마다 모니터링
    });

    // 쿼리 성능 모니터링
    mongoose.set('debug', (coll, method, query, doc) => {
      if (process.env.NODE_ENV === 'development') {
        console.log(`🔍 DB Query: ${coll}.${method}(${JSON.stringify(query)})`);
      }
    });
  }

  // 쿼리 최적화 설정
  setupQueryOptimization() {
    // 느린 쿼리 감지
    mongoose.connection.on('connected', () => {
      if (mongoose.connection.db) {
        mongoose.connection.db.on('commandStarted', (event) => {
          this.queryStartTimes = this.queryStartTimes || {};
          this.queryStartTimes[event.requestId] = Date.now();
        });

        mongoose.connection.db.on('commandSucceeded', (event) => {
          if (this.queryStartTimes && this.queryStartTimes[event.requestId]) {
            const duration = Date.now() - this.queryStartTimes[event.requestId];
            if (duration > 1000) { // 1초 이상 걸린 쿼리
              console.warn(`⚠️ Slow Query Detected: ${event.commandName} took ${duration}ms`);
            }
            delete this.queryStartTimes[event.requestId];
          }
        });
      }
    });
  }

  // 최적화된 메시지 조회 (페이지네이션 + 캐싱)
  async getOptimizedMessages(roomId, page = 1, limit = 30) {
    // 캐시에서 먼저 확인
    const cached = await cacheService.getRecentMessages(roomId, page);
    if (cached) {
      return cached;
    }

    const skip = (page - 1) * limit;
    
    // 최적화된 쿼리: 필요한 필드만 선택, 인덱스 활용
    const messages = await Message.find({
      room: roomId,
      isDeleted: false
    })
    .select('content sender type timestamp reactions readers file aiType mentions')
    .populate('sender', 'name email profileImage')
    .populate('file', 'filename originalname mimetype size')
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(limit)
    .lean() // 성능 향상을 위해 lean() 사용
    .exec();

    // 결과를 캐시에 저장
    await cacheService.cacheRecentMessages(roomId, page, messages);

    return messages;
  }

  // 최적화된 채팅방 목록 조회
  async getOptimizedRooms(userId, page = 1, limit = 20) {
    // 캐시에서 먼저 확인
    const cached = await cacheService.getUserRooms(userId);
    if (cached) {
      return cached.slice((page - 1) * limit, page * limit);
    }

    // 집계 파이프라인을 사용한 최적화된 쿼리
    const rooms = await Room.aggregate([
      {
        $match: {
          participants: new mongoose.Types.ObjectId(userId)
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'participants',
          foreignField: '_id',
          as: 'participantDetails',
          pipeline: [
            { $project: { name: 1, email: 1, profileImage: 1 } }
          ]
        }
      },
      {
        $lookup: {
          from: 'messages',
          let: { roomId: { $toString: '$_id' } },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$room', '$$roomId'] },
                isDeleted: false
              }
            },
            { $sort: { timestamp: -1 } },
            { $limit: 1 },
            { $project: { content: 1, timestamp: 1, sender: 1, type: 1 } }
          ],
          as: 'lastMessage'
        }
      },
      {
        $addFields: {
          lastMessage: { $arrayElemAt: ['$lastMessage', 0] },
          participantCount: { $size: '$participants' }
        }
      },
      {
        $sort: { 'lastMessage.timestamp': -1, createdAt: -1 }
      },
      {
        $skip: (page - 1) * limit
      },
      {
        $limit: limit
      }
    ]);

    // 전체 결과를 캐시에 저장 (첫 페이지인 경우)
    if (page === 1) {
      await cacheService.cacheUserRooms(userId, rooms);
    }

    return rooms;
  }

  // 최적화된 사용자 프로필 조회
  async getOptimizedUserProfile(userId) {
    // 캐시에서 먼저 확인
    const cached = await cacheService.getUserProfile(userId);
    if (cached) {
      return cached;
    }

    const user = await User.findById(userId)
      .select('name email profileImage lastActive createdAt')
      .lean();

    if (user) {
      await cacheService.cacheUserProfile(userId, user);
    }

    return user;
  }

  // 메시지 카운트 최적화
  async getOptimizedMessageCount(roomId) {
    // 캐시에서 먼저 확인
    const cached = await cacheService.getMessageCount(roomId);
    if (cached !== null) {
      return cached;
    }

    const count = await Message.countDocuments({
      room: roomId,
      isDeleted: false
    });

    await cacheService.cacheMessageCount(roomId, count);
    return count;
  }

  // 배치 작업: 읽음 처리 최적화
  async batchMarkAsRead(messageIds, userId) {
    if (!messageIds?.length) return 0;

    // 배치 업데이트로 성능 향상
    const result = await Message.bulkWrite(
      messageIds.map(messageId => ({
        updateOne: {
          filter: {
            _id: messageId,
            isDeleted: false,
            'readers.userId': { $ne: userId }
          },
          update: {
            $push: {
              readers: {
                userId: new mongoose.Types.ObjectId(userId),
                readAt: new Date()
              }
            }
          }
        }
      })),
      { ordered: false }
    );

    return result.modifiedCount;
  }

  // 인덱스 최적화 확인
  async checkIndexes() {
    const collections = ['messages', 'rooms', 'users', 'files'];
    const indexInfo = {};

    for (const collName of collections) {
      try {
        const collection = mongoose.connection.db.collection(collName);
        const indexes = await collection.indexes();
        indexInfo[collName] = indexes;
        
        // 사용되지 않는 인덱스 감지 (실제 프로덕션에서는 더 정교한 분석 필요)
        console.log(`📊 ${collName} indexes:`, indexes.map(idx => idx.name));
      } catch (error) {
        console.error(`Error checking indexes for ${collName}:`, error);
      }
    }

    return indexInfo;
  }

  // 데이터베이스 통계 수집
  async getDBStats() {
    try {
      const stats = await mongoose.connection.db.stats();
      const serverStatus = await mongoose.connection.db.admin().serverStatus();
      
      return {
        collections: stats.collections,
        dataSize: stats.dataSize,
        indexSize: stats.indexSize,
        connections: serverStatus.connections,
        opcounters: serverStatus.opcounters,
        timestamp: new Date()
      };
    } catch (error) {
      console.error('Error getting DB stats:', error);
      return null;
    }
  }

  // 메모리 사용량 모니터링
  getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      rss: Math.round(usage.rss / 1024 / 1024), // MB
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
      external: Math.round(usage.external / 1024 / 1024),
      timestamp: new Date()
    };
  }

  // 정리 작업 (오래된 데이터 삭제)
  async cleanupOldData() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    try {
      // 30일 이상 된 삭제된 메시지 완전 삭제
      const deletedMessages = await Message.deleteMany({
        isDeleted: true,
        updatedAt: { $lt: thirtyDaysAgo }
      });

      console.log(`🧹 Cleaned up ${deletedMessages.deletedCount} old deleted messages`);

      // 비활성 세션 정리는 SessionService에서 처리
      return {
        deletedMessages: deletedMessages.deletedCount
      };
    } catch (error) {
      console.error('Cleanup error:', error);
      return { error: error.message };
    }
  }
}

module.exports = new DBOptimizationService(); 