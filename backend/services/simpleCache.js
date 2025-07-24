// backend/services/simpleCache.js
const redisClient = require('../utils/redisClient');

class SimpleCacheService {
  constructor() {
    this.TTL = {
      USER_PROFILE: 1800,
      ROOM_INFO: 900,
      ROOM_LIST: 300,
      MESSAGES: 180,
      USER_ROOMS: 600
    };
  }

  async set(key, data, ttl = 300) {
    try {
      await redisClient.setEx(key, ttl, JSON.stringify(data));
      console.log(`📦 캐시 저장: ${key} (TTL: ${ttl}s)`);
      return true;
    } catch (error) {
      console.error('캐시 저장 실패:', error);
      return false;
    }
  }

  async get(key) {
    try {
      const cached = await redisClient.get(key);
      if (cached) {
        console.log(`✅ 캐시 히트: ${key}`);
        
        // 🔥 안전한 JSON 파싱 개선
        if (typeof cached === 'object') {
          return cached;
        }
        
        if (typeof cached === 'string' && 
            cached !== '[object Object]' && 
            cached !== 'undefined' && 
            cached !== 'null') {
          try {
            return JSON.parse(cached);
          } catch (parseError) {
            console.error(`JSON 파싱 실패 (${key}):`, parseError.message);
            await this.del(key);
            return null;
          }
        }
        return cached;
      }
      console.log(`❌ 캐시 미스: ${key}`);
      return null;
    } catch (error) {
      console.error('캐시 조회 실패:', error);
      return null;
    }
  }

  async del(key) {
    try {
      await redisClient.del(key);
      console.log(`🗑️ 캐시 삭제: ${key}`);
      return true;
    } catch (error) {
      console.error('캐시 삭제 실패:', error);
      return false;
    }
  }

  // 채팅방 목록 캐싱
  async cacheRoomList(page, pageSize, sortField, sortOrder, rooms) {
    const key = `rooms:list:${page}:${pageSize}:${sortField}:${sortOrder}`;
    return await this.set(key, rooms, this.TTL.ROOM_LIST);
  }

  async getRoomList(page, pageSize, sortField, sortOrder) {
    const key = `rooms:list:${page}:${pageSize}:${sortField}:${sortOrder}`;
    return await this.get(key);
  }

  // 🔥 개선된 채팅방 목록 캐시 무효화
  async invalidateRoomList() {
    try {
      const keys = await redisClient.keys('rooms:list:*');
      if (keys.length > 0) {
        await redisClient.del(...keys);
        console.log(`🗑️ 채팅방 목록 캐시 전체 삭제: ${keys.length}개`);
      }
      
      // 🔥 추가: rooms:* 패턴의 모든 키도 삭제
      const roomKeys = await redisClient.keys('rooms:*');
      if (roomKeys.length > 0) {
        await redisClient.del(...roomKeys);
        console.log(`🗑️ 채팅방 관련 캐시 전체 삭제: ${roomKeys.length}개`);
      }
      
      return true;
    } catch (error) {
      console.error('채팅방 목록 캐시 삭제 실패:', error);
      return false;
    }
  }

  // 채팅방 정보 캐싱
  async cacheRoomInfo(roomId, roomData) {
    const key = `room:${roomId}`;
    return await this.set(key, roomData, this.TTL.ROOM_INFO);
  }

  async getRoomInfo(roomId) {
    const key = `room:${roomId}`;
    return await this.get(key);
  }

  async invalidateRoomInfo(roomId) {
    const key = `room:${roomId}`;
    return await this.del(key);
  }

  // 사용자 프로필 캐싱
  async cacheUserProfile(userId, userData) {
    const key = `user:${userId}`;
    return await this.set(key, userData, this.TTL.USER_PROFILE);
  }

  async getUserProfile(userId) {
    const key = `user:${userId}`;
    return await this.get(key);
  }

  async invalidateUserProfile(userId) {
    const key = `user:${userId}`;
    return await this.del(key);
  }

  // 사용자의 채팅방 목록 캐싱
  async cacheUserRooms(userId, rooms) {
    const key = `user:${userId}:rooms`;
    return await this.set(key, rooms, this.TTL.USER_ROOMS);
  }

  async getUserRooms(userId) {
    const key = `user:${userId}:rooms`;
    return await this.get(key);
  }

  async invalidateUserRooms(userId) {
    const key = `user:${userId}:rooms`;
    return await this.del(key);
  }

  // 최근 메시지 캐싱
  async cacheRecentMessages(roomId, messages) {
    const key = `messages:${roomId}:recent`;
    return await this.set(key, messages, this.TTL.MESSAGES);
  }

  async getRecentMessages(roomId) {
    const key = `messages:${roomId}:recent`;
    return await this.get(key);
  }

  async invalidateMessages(roomId) {
    const key = `messages:${roomId}:recent`;
    return await this.del(key);
  }

  // 🔥 새로 추가: 특정 사용자와 관련된 모든 캐시 무효화
  async invalidateUserRelatedCaches(userId) {
    try {
      const patterns = [
        `user:${userId}*`,
        `rooms:*`,  // 사용자가 참여한 방 목록이 변경될 수 있으므로
      ];
      
      for (const pattern of patterns) {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) {
          await redisClient.del(...keys);
          console.log(`🗑️ 사용자 관련 캐시 삭제 (${pattern}): ${keys.length}개`);
        }
      }
      return true;
    } catch (error) {
      console.error('사용자 관련 캐시 무효화 실패:', error);
      return false;
    }
  }

  // 캐시 상태 확인
  async getStats() {
    try {
      const info = await redisClient.client.info('memory');
      const keyspace = await redisClient.client.info('keyspace');
      
      return {
        memory: info,
        keyspace: keyspace,
        connected: redisClient.client.status === 'ready'
      };
    } catch (error) {
      console.error('캐시 상태 조회 실패:', error);
      return { connected: false, error: error.message };
    }
  }

  // 전체 캐시 초기화
  async clearAll() {
    try {
      await redisClient.client.flushdb();
      console.log('🧹 모든 캐시 삭제 완료');
      return true;
    } catch (error) {
      console.error('캐시 초기화 실패:', error);
      return false;
    }
  }
}

module.exports = new SimpleCacheService();