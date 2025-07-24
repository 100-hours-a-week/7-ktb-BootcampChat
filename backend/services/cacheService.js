const redisClient = require('../utils/redisClient');

class CacheService {
  constructor() {
    this.TTL = {
      USER_PROFILE: 3600, // 1시간
      ROOM_INFO: 1800, // 30분
      MESSAGES: 300, // 5분
      FILE_METADATA: 7200, // 2시간
      ACTIVE_USERS: 60, // 1분
      ROOM_PARTICIPANTS: 300, // 5분
      MESSAGE_COUNT: 600, // 10분
      USER_ROOMS: 900 // 15분
    };
  }

  // 캐시 서비스 초기화
  async initialize() {
    try {
      console.log('🔄 Redis 캐시 서비스 초기화 중...');
      
      // Redis 연결 상태 확인
      const pingResult = await redisClient.ping();
      if (pingResult !== 'PONG') {
        throw new Error('Redis connection failed');
      }
      
      console.log('✅ Redis 캐시 서비스 초기화 완료');
      return true;
    } catch (error) {
      console.error('❌ Redis 캐시 서비스 초기화 실패:', error);
      throw error;
    }
  }

  // 캐시 정리 (graceful shutdown용)
  async cleanup() {
    try {
      console.log('🧹 캐시 정리 중...');
      // 필요시 특정 캐시 정리 로직 추가
      console.log('✅ 캐시 정리 완료');
    } catch (error) {
      console.error('❌ 캐시 정리 실패:', error);
    }
  }

  // 사용자 프로필 캐싱
  async cacheUserProfile(userId, userData) {
    const key = `user:profile:${userId}`;
    return await redisClient.setEx(key, this.TTL.USER_PROFILE, JSON.stringify(userData));
  }

  async getUserProfile(userId) {
    const key = `user:profile:${userId}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  // 채팅방 정보 캐싱
  async cacheRoomInfo(roomId, roomData) {
    const key = `room:info:${roomId}`;
    return await redisClient.setEx(key, this.TTL.ROOM_INFO, JSON.stringify(roomData));
  }

  async getRoomInfo(roomId) {
    const key = `room:info:${roomId}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  // 최근 메시지 캐싱 (페이지네이션 최적화)
  async cacheRecentMessages(roomId, page, messages) {
    const key = `room:messages:${roomId}:page:${page}`;
    return await redisClient.setEx(key, this.TTL.MESSAGES, JSON.stringify(messages));
  }

  async getRecentMessages(roomId, page) {
    const key = `room:messages:${roomId}:page:${page}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  // 파일 메타데이터 캐싱
  async cacheFileMetadata(fileId, metadata) {
    const key = `file:metadata:${fileId}`;
    return await redisClient.setEx(key, this.TTL.FILE_METADATA, JSON.stringify(metadata));
  }

  async getFileMetadata(fileId) {
    const key = `file:metadata:${fileId}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  // 활성 사용자 캐싱
  async setActiveUser(userId, socketId) {
    const key = `active:users:${userId}`;
    return await redisClient.setEx(key, this.TTL.ACTIVE_USERS, socketId);
  }

  async getActiveUser(userId) {
    const key = `active:users:${userId}`;
    return await redisClient.get(key);
  }

  async removeActiveUser(userId) {
    const key = `active:users:${userId}`;
    return await redisClient.del(key);
  }

  // 채팅방 참여자 캐싱
  async cacheRoomParticipants(roomId, participants) {
    const key = `room:participants:${roomId}`;
    return await redisClient.setEx(key, this.TTL.ROOM_PARTICIPANTS, JSON.stringify(participants));
  }

  async getRoomParticipants(roomId) {
    const key = `room:participants:${roomId}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  // 메시지 카운트 캐싱
  async cacheMessageCount(roomId, count) {
    const key = `room:message_count:${roomId}`;
    return await redisClient.setEx(key, this.TTL.MESSAGE_COUNT, count.toString());
  }

  async getMessageCount(roomId) {
    const key = `room:message_count:${roomId}`;
    const cached = await redisClient.get(key);
    return cached ? parseInt(cached) : null;
  }

  // 사용자의 참여 채팅방 목록 캐싱
  async cacheUserRooms(userId, rooms) {
    const key = `user:rooms:${userId}`;
    return await redisClient.setEx(key, this.TTL.USER_ROOMS, JSON.stringify(rooms));
  }

  async getUserRooms(userId) {
    const key = `user:rooms:${userId}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  // 캐시 무효화 메서드들
  async invalidateUserCache(userId) {
    const keys = [
      `user:profile:${userId}`,
      `user:rooms:${userId}`,
      `active:users:${userId}`
    ];
    return await Promise.all(keys.map(key => redisClient.del(key)));
  }

  async invalidateRoomCache(roomId) {
    // 방 관련 모든 캐시 삭제
    const pattern = `room:*:${roomId}*`;
    // Redis SCAN 명령어로 패턴 매칭 키들 찾아서 삭제
    // 실제 구현에서는 더 정교한 패턴 매칭 필요
    const keys = [
      `room:info:${roomId}`,
      `room:participants:${roomId}`,
      `room:message_count:${roomId}`
    ];
    return await Promise.all(keys.map(key => redisClient.del(key)));
  }

  // 통계 정보 캐싱
  async cacheStats(key, data, ttl = 300) {
    return await redisClient.setEx(`stats:${key}`, ttl, JSON.stringify(data));
  }

  async getStats(key) {
    const cached = await redisClient.get(`stats:${key}`);
    return cached ? JSON.parse(cached) : null;
  }

  // 부하 분산을 위한 서버 상태 캐싱
  async setServerHealth(serverId, healthData) {
    const key = `server:health:${serverId}`;
    return await redisClient.setEx(key, 30, JSON.stringify(healthData)); // 30초
  }

  async getServerHealth(serverId) {
    const key = `server:health:${serverId}`;
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  }
}

module.exports = new CacheService(); 