const Room = require('../models/Room');
const User = require('../models/User');
const Message = require('../models/Message');

class QueryOptimizer {
  constructor() {
    this.queryStats = new Map();
  }

  // 최적화된 채팅방 목록 조회
  async getOptimizedRooms(filter = {}, options = {}) {
    const {
      page = 0,
      pageSize = 10,
      sortField = 'createdAt',
      sortOrder = 'desc',
      includeParticipants = true
    } = options;

    const skip = page * pageSize;
    const sort = { [sortField]: sortOrder === 'desc' ? -1 : 1 };

    // 기본 쿼리 (lean으로 성능 향상)
    let query = Room.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(pageSize)
      .lean(); // 🚀 Mongoose 객체 생성 생략

    // 선택적 populate (필요한 필드만)
    if (includeParticipants) {
      query = query
        .populate('creator', 'name email', null, { lean: true })
        .populate('participants', 'name email', null, { lean: true });
    } else {
      query = query.select('-participants'); // 참가자 정보 제외
    }

    return await query;
  }

  // 최적화된 메시지 조회
  async getOptimizedMessages(roomId, options = {}) {
    const {
      page = 0,
      pageSize = 50,
      before = null, // 특정 시간 이전 메시지
      includeReactions = false,
      includeReadStatus = false
    } = options;

    const skip = page * pageSize;
    const filter = { room: roomId };

    // 시간 필터 추가
    if (before) {
      filter.createdAt = { $lt: new Date(before) };
    }

    // 필드 선택 (필요한 것만)
    let selectFields = 'content type sender createdAt file aiType';
    
    if (includeReactions) selectFields += ' reactions';
    if (includeReadStatus) selectFields += ' readBy';

    return await Message.find(filter)
      .select(selectFields)
      .populate('sender', 'name email avatarInitial', null, { lean: true })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean(); // 🚀 성능 향상
  }

  // 집계 파이프라인: 방별 메시지 통계
  async getRoomMessageStats(roomId) {
    return await Message.aggregate([
      { $match: { room: roomId } },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          lastMessage: { $max: '$createdAt' },
          users: { $addToSet: '$sender' }
        }
      },
      {
        $project: {
          messageType: '$_id',
          count: 1,
          lastMessage: 1,
          uniqueUsers: { $size: '$users' }
        }
      },
      { $sort: { count: -1 } }
    ]);
  }

  // 집계 파이프라인: 사용자 활동 통계
  async getUserActivityStats(userId, days = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return await Message.aggregate([
      {
        $match: {
          sender: userId,
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            type: '$type'
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: '$_id.date',
          messageTypes: {
            $push: {
              type: '$_id.type',
              count: '$count'
            }
          },
          totalMessages: { $sum: '$count' }
        }
      },
      { $sort: { _id: 1 } }
    ]);
  }

  // 배치 작업: 읽음 상태 업데이트
  async batchMarkAsRead(messageIds, userId) {
    return await Message.updateMany(
      {
        _id: { $in: messageIds },
        'readBy.user': { $ne: userId }
      },
      {
        $push: {
          readBy: {
            user: userId,
            readAt: new Date()
          }
        }
      }
    );
  }

  // 배치 작업: 오래된 메시지 정리
  async cleanupOldMessages(days = 90) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const result = await Message.deleteMany({
      createdAt: { $lt: cutoffDate },
      type: { $ne: 'system' } // 시스템 메시지는 보존
    });

    console.log(`🧹 ${result.deletedCount}개의 오래된 메시지 삭제됨`);
    return result;
  }

  // 텍스트 검색 최적화
  async searchMessages(query, roomId = null, limit = 20) {
    const searchFilter = {
      $text: { $search: query }
    };

    if (roomId) {
      searchFilter.room = roomId;
    }

    return await Message.find(searchFilter)
      .select('content sender room createdAt score: { $meta: "textScore" }')
      .populate('sender', 'name', null, { lean: true })
      .populate('room', 'name', null, { lean: true })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean();
  }

  // 쿼리 성능 추적
  trackQuery(queryName, startTime) {
    const duration = Date.now() - startTime;
    
    if (!this.queryStats.has(queryName)) {
      this.queryStats.set(queryName, {
        count: 0,
        totalTime: 0,
        avgTime: 0,
        maxTime: 0,
        minTime: Infinity
      });
    }

    const stats = this.queryStats.get(queryName);
    stats.count++;
    stats.totalTime += duration;
    stats.avgTime = stats.totalTime / stats.count;
    stats.maxTime = Math.max(stats.maxTime, duration);
    stats.minTime = Math.min(stats.minTime, duration);

    // 느린 쿼리 경고
    if (duration > 1000) {
      console.warn(`🐌 느린 쿼리 감지: ${queryName} - ${duration}ms`);
    }

    return duration;
  }

  // 성능 통계 조회
  getQueryStats() {
    const stats = {};
    for (const [queryName, data] of this.queryStats) {
      stats[queryName] = {
        ...data,
        avgTime: Math.round(data.avgTime * 100) / 100
      };
    }
    return stats;
  }

  // 통계 초기화
  resetStats() {
    this.queryStats.clear();
    console.log('📊 쿼리 통계 초기화됨');
  }

  // 인덱스 힌트 사용 예제
  async getMessagesWithHint(roomId, indexName = 'room_messages') {
    return await Message.find({ room: roomId })
      .hint(indexName) // 🎯 특정 인덱스 강제 사용
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
  }

  // 메모리 효율적인 대용량 데이터 처리
  async processLargeDataset(callback) {
    const cursor = Message.find({}).lean().cursor();
    
    let processedCount = 0;
    
    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      await callback(doc);
      processedCount++;
      
      if (processedCount % 1000 === 0) {
        console.log(`📊 처리된 문서: ${processedCount}개`);
      }
    }
    
    return processedCount;
  }
}

module.exports = new QueryOptimizer(); 