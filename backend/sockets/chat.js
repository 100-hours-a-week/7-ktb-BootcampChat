// backend/sockets/chat.js - 최종 최적화 버전 (300명까지 대응)
const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const File = require('../models/File');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');

module.exports = function(io) {
  // ===== 메모리 누수 방지를 위한 제한된 Map 클래스 =====
  class LimitedMap extends Map {
    constructor(maxSize = 1000) {
      super();
      this.maxSize = maxSize;
      this.hitCount = 0;
      this.missCount = 0;
    }
    
    set(key, value) {
      if (this.size >= this.maxSize) {
        // LRU 방식으로 가장 오래된 항목 제거
        const oldestKey = this.keys().next().value;
        this.delete(oldestKey);
      }
      return super.set(key, value);
    }

    get(key) {
      const value = super.get(key);
      if (value) this.hitCount++;
      else this.missCount++;
      return value;
    }

    getStats() {
      return {
        size: this.size,
        hitRate: this.hitCount / (this.hitCount + this.missCount) || 0,
        maxSize: this.maxSize
      };
    }
  }

  // ===== 최적화된 데이터 구조 =====
  const connectedUsers = new LimitedMap(2000);    // 사용자 연결 관리
  const streamingSessions = new LimitedMap(500);  // AI 스트리밍 세션
  const userRooms = new LimitedMap(2000);         // 사용자별 현재 방
  const messageQueues = new LimitedMap(1000);     // 메시지 로드 큐
  const messageLoadRetries = new LimitedMap(200); // 재시도 관리
  const rateLimitCache = new LimitedMap(2000);    // 레이트 리미트 캐시
  
  // ===== 성능 최적화 상수 =====
  const BATCH_SIZE = 25;                    // 한번에 로드할 메시지 수
  const LOAD_DELAY = 300;                   // 메시지 로드 딜레이 (ms)
  const MAX_RETRIES = 3;                    // 최대 재시도 횟수
  const MESSAGE_LOAD_TIMEOUT = 8000;        // 메시지 로드 타임아웃 (8초)
  const RETRY_DELAY = 1500;                 // 재시도 간격 (1.5초)
  const DUPLICATE_LOGIN_TIMEOUT = 8000;     // 중복 로그인 타임아웃 (8초)
  const CLEANUP_INTERVAL = 3 * 60 * 1000;   // 메모리 정리 간격 (3분)
  const RATE_LIMIT_WINDOW = 60000;          // 레이트 리미트 윈도우 (1분)
  const RATE_LIMIT_MAX = 40;                // 분당 최대 메시지 수
  
  // 배치 처리를 위한 메시지 버퍼 (사용하지 않음 - 즉시 처리로 변경)
  // const messageBuffer = [];
  // const BUFFER_SIZE = 8;                    // 배치 크기
  // const BUFFER_TIMEOUT = 150;               // 배치 플러시 간격 (ms)

  // ===== 로깅 유틸리티 =====
  const logDebug = (action, data) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[Socket.IO] ${action}:`, {
        ...data,
        timestamp: new Date().toISOString()
      });
    }
  };

  const logError = (action, error, data = {}) => {
    console.error(`[Socket.IO ERROR] ${action}:`, {
      error: error.message,
      stack: error.stack,
      ...data,
      timestamp: new Date().toISOString()
    });
  };

  // ===== 메모리 정리 및 모니터링 =====
  const memoryCleanup = setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    
    try {
      // 1. 비활성 스트리밍 세션 정리 (30분 이상)
      for (const [sessionId, session] of streamingSessions.entries()) {
        if (now - session.lastActivity > 30 * 60 * 1000) {
          streamingSessions.delete(sessionId);
          cleanedCount++;
        }
      }
      
      // 2. 오래된 레이트 리미트 캐시 정리 (2분 이상)
      for (const [key, data] of rateLimitCache.entries()) {
        if (now - data.timestamp > 2 * 60 * 1000) {
          rateLimitCache.delete(key);
          cleanedCount++;
        }
      }
      
      // 3. 연결이 끊어진 사용자 정리
      for (const [userId, socketId] of connectedUsers.entries()) {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket || !socket.connected) {
          connectedUsers.delete(userId);
          userRooms.delete(userId);
          cleanedCount++;
        }
      }
      
      // 4. 오래된 메시지 로드 재시도 정리 (5분 이상)
      for (const [retryKey, retryData] of messageLoadRetries.entries()) {
        if (now - retryData.lastAttempt > 5 * 60 * 1000) {
          messageLoadRetries.delete(retryKey);
          cleanedCount++;
        }
      }
      
      // 5. 메모리 사용량 체크 및 강제 정리
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      
      if (heapUsedMB > 1200) { // 1.2GB 초과시 경고
        console.warn(`[MEMORY WARNING] Heap usage: ${heapUsedMB}MB`);
        
        if (heapUsedMB > 1500) { // 1.5GB 초과시 강제 정리
          console.error('[CRITICAL MEMORY] Forcing cleanup');
          rateLimitCache.clear();
          messageQueues.clear();
          
          if (global.gc) {
            global.gc();
          }
        }
      }
      
      logDebug('memory cleanup completed', {
        cleanedItems: cleanedCount,
        connectedUsers: connectedUsers.size,
        streamingSessions: streamingSessions.size,
        messageQueues: messageQueues.size,
        rateLimitCache: rateLimitCache.size,
        heapUsedMB,
        cacheHitRates: {
          connectedUsers: connectedUsers.getStats().hitRate,
          rateLimitCache: rateLimitCache.getStats().hitRate
        }
      });
      
    } catch (error) {
      logError('memory cleanup error', error);
    }
  }, CLEANUP_INTERVAL);

  // ===== 배치 메시지 처리 (사용 안함 - 즉시 처리로 변경) =====
  /*
  const flushMessageBuffer = async () => {
    // 배치 처리 코드 제거 - 즉시 처리 방식 사용
  };

  // 주기적으로 메시지 버퍼 플러시 (사용 안함)
  // const bufferFlushInterval = setInterval(flushMessageBuffer, BUFFER_TIMEOUT);
  */

  // ===== 최적화된 메시지 로드 함수 =====
  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    let timeoutId;
    
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Message loading timed out'));
      }, MESSAGE_LOAD_TIMEOUT);
    });

    try {
      // Redis 캐시 확인
      const cacheKey = `messages:${roomId}:${before || 'latest'}:${limit}`;
      
      try {
        const cachedResult = await redisClient.get(cacheKey);
        if (cachedResult) {
          logDebug('messages loaded from cache', { roomId, cacheKey });
          
          // 타임아웃 정리
          if (timeoutId) clearTimeout(timeoutId);
          
          // 이미 객체인 경우 그대로 사용, 문자열인 경우만 파싱
          if (typeof cachedResult === 'object') {
            return cachedResult;
          } else if (typeof cachedResult === 'string') {
            try {
              return JSON.parse(cachedResult);
            } catch (parseError) {
              logError('cache parse error', parseError, { cacheKey });
              // 파싱 실패시 캐시 무시하고 DB에서 로드
            }
          }
        }
      } catch (cacheError) {
        logError('cache read error', cacheError, { cacheKey });
        // 캐시 에러는 무시하고 DB에서 로드
      }

      // 쿼리 구성
      const query = { 
        room: roomId,
        isDeleted: { $ne: true }
      };
      if (before) {
        query.timestamp = { $lt: new Date(before) };
      }

      // 최적화된 DB 쿼리
      const dbPromise = Message.find(query, {
        // 필요한 필드만 선택
        _id: 1,
        content: 1,
        sender: 1,
        type: 1,
        timestamp: 1,
        file: 1,
        aiType: 1,
        mentions: 1,
        reactions: 1
      })
      .populate('sender', 'name email profileImage')
      .populate('file', 'filename originalname mimetype size')
      .sort({ timestamp: -1 })
      .limit(limit + 1)
      .lean() // 성능 향상을 위해 lean() 사용
      .hint({ room: 1, timestamp: -1 }); // 인덱스 힌트

      const messages = await Promise.race([dbPromise, timeoutPromise]);

      // 타임아웃 정리
      if (timeoutId) clearTimeout(timeoutId);

      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const sortedMessages = resultMessages.sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );

      const result = {
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages.length > 0 ? sortedMessages[0].timestamp : null
      };

      // Redis에 30초간 캐시
      try {
        await redisClient.setex(cacheKey, 30, JSON.stringify(result));
      } catch (cacheError) {
        logError('cache write error', cacheError, { cacheKey });
        // 캐시 에러는 무시
      }

      // 읽음 상태 비동기 업데이트 (에러 발생해도 메시지 로드는 계속)
      if (sortedMessages.length > 0 && socket.user) {
        const messageIds = sortedMessages.map(msg => msg._id);
        Message.updateMany(
          {
            _id: { $in: messageIds },
            'readers.userId': { $ne: socket.user.id }
          },
          {
            $push: {
              readers: {
                userId: socket.user.id,
                readAt: new Date()
              }
            }
          }
        ).catch(err => {
          logError('read status update error', err, { messageIds: messageIds.length });
        });
      }

      return result;

    } catch (error) {
      // 타임아웃 정리
      if (timeoutId) clearTimeout(timeoutId);
      
      logError('load messages error', error, { roomId, before, limit });
      throw error;
    }
  };

  // ===== 재시도 로직이 포함된 메시지 로드 =====
  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}:${before || 'initial'}`;
    
    try {
      const result = await loadMessages(socket, roomId, before);
      
      // 성공 시 재시도 기록 삭제
      messageLoadRetries.delete(retryKey);
      return result;

    } catch (error) {
      if (retryCount < MAX_RETRIES) {
        const delay = Math.min(RETRY_DELAY * Math.pow(1.5, retryCount), 5000);
        
        // 재시도 기록 업데이트
        messageLoadRetries.set(retryKey, {
          count: retryCount + 1,
          lastAttempt: Date.now()
        });
        
        logDebug('retrying message load', {
          roomId,
          retryCount: retryCount + 1,
          delay,
          error: error.message
        });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, retryCount + 1);
      }

      messageLoadRetries.delete(retryKey);
      throw error;
    }
  };

  // ===== 레이트 리미팅 함수 =====
  const checkRateLimit = async (userId) => {
    const now = Date.now();
    const minute = Math.floor(now / RATE_LIMIT_WINDOW);
    const rateLimitKey = `${userId}:${minute}`;
    
    // 메모리 캐시 먼저 확인
    const cached = rateLimitCache.get(rateLimitKey);
    if (cached) {
      if (cached.count >= RATE_LIMIT_MAX) {
        throw new Error(`메시지 전송 한도를 초과했습니다. (${RATE_LIMIT_MAX}개/분)`);
      }
      cached.count++;
      return;
    }

    // Redis 확인
    try {
      const key = `rate_limit:${rateLimitKey}`;
      const count = await redisClient.incr(key);
      
      if (count === 1) {
        await redisClient.expire(key, 60);
      }
      
      if (count > RATE_LIMIT_MAX) {
        throw new Error(`메시지 전송 한도를 초과했습니다. (${RATE_LIMIT_MAX}개/분)`);
      }

      // 메모리 캐시에 저장
      rateLimitCache.set(rateLimitKey, { count, timestamp: now });
      
    } catch (redisError) {
      if (redisError.message.includes('메시지 전송 한도')) {
        throw redisError;
      }
      
      logError('redis rate limit error', redisError, { userId });
      // Redis 에러시 메모리 캐시만 사용
      rateLimitCache.set(rateLimitKey, { count: 1, timestamp: now });
    }
  };

  // ===== 중복 로그인 처리 =====
  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      existingSocket.emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: newSocket.handshake.headers['user-agent'],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now()
      });

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try {
            existingSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            existingSocket.disconnect(true);
          } catch (error) {
            logError('session termination error', error);
          } finally {
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);

        // 기존 소켓이 먼저 연결 해제되면 타임아웃 정리
        existingSocket.on('disconnect', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch (error) {
      logError('duplicate login handling error', error);
      throw error;
    }
  };

  // ===== Socket.IO 미들웨어 - 인증 처리 =====
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;

      if (!token || !sessionId) {
        return next(new Error('Authentication error'));
      }

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) {
        return next(new Error('Invalid token'));
      }

      // 중복 로그인 체크 및 처리
      const existingSocketId = connectedUsers.get(decoded.user.id);
      if (existingSocketId && existingSocketId !== socket.id) {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          await handleDuplicateLogin(existingSocket, socket);
        }
      }

      // 세션 검증
      const validationResult = await SessionService.validateSession(decoded.user.id, sessionId);
      if (!validationResult.isValid) {
        logError('session validation failed', new Error(validationResult.message), {
          userId: decoded.user.id,
          sessionId
        });
        return next(new Error(validationResult.message || 'Invalid session'));
      }

      // 사용자 정보 캐시에서 확인
      const userCacheKey = `user:${decoded.user.id}`;
      let user;
      
      try {
        const cachedUser = await redisClient.get(userCacheKey);
        if (cachedUser) {
          // 이미 객체인 경우 그대로 사용
          if (typeof cachedUser === 'object') {
            user = cachedUser;
          } else if (typeof cachedUser === 'string') {
            try {
              user = JSON.parse(cachedUser);
            } catch (parseError) {
              logError('user cache parse error', parseError, { userCacheKey });
              // 파싱 실패시 DB에서 다시 로드
            }
          }
        }
      } catch (cacheError) {
        logError('user cache read error', cacheError, { userCacheKey });
      }
      
      if (!user) {
        const userDoc = await User.findById(decoded.user.id, 'name email profileImage').lean();
        if (!userDoc) {
          return next(new Error('User not found'));
        }
        
        user = userDoc;
        
        // 사용자 정보 캐시 (5분)
        try {
          await redisClient.setex(userCacheKey, 300, JSON.stringify(user));
        } catch (cacheError) {
          logError('user cache write error', cacheError, { userCacheKey });
        }
      }

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage
      };

      // 세션 활동 시간 비동기 업데이트
      SessionService.updateLastActivity(decoded.user.id).catch(err => {
        logError('update last activity error', err, { userId: decoded.user.id });
      });

      next();

    } catch (error) {
      logError('socket authentication error', error);
      
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Token expired'));
      }
      
      if (error.name === 'JsonWebTokenError') {
        return next(new Error('Invalid token'));
      }
      
      next(new Error('Authentication failed'));
    }
  });

  // ===== Socket 연결 처리 =====
  io.on('connection', (socket) => {
    logDebug('socket connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name
    });

    if (socket.user) {
      // 연결 정보 저장
      const previousSocketId = connectedUsers.get(socket.user.id);
      if (previousSocketId && previousSocketId !== socket.id) {
        // 이미 중복 로그인 처리가 완료되었으므로 단순히 업데이트
        logDebug('replacing previous connection', {
          userId: socket.user.id,
          previousSocketId,
          newSocketId: socket.id
        });
      }
      
      connectedUsers.set(socket.user.id, socket.id);
    }

    // ===== 이전 메시지 로딩 처리 =====
    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}:${before || 'initial'}`;

      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 이미 로딩 중인 요청인지 확인
        if (messageQueues.has(queueKey)) {
          logDebug('message load skipped - already loading', {
            roomId,
            userId: socket.user.id,
            before
          });
          return;
        }

        // 권한 체크 (캐시 활용)
        const roomCacheKey = `room_access:${roomId}:${socket.user.id}`;
        let hasAccess;
        
        try {
          hasAccess = await redisClient.get(roomCacheKey);
        } catch (cacheError) {
          logError('room access cache error', cacheError);
        }
        
        if (!hasAccess) {
          const room = await Room.findOne({
            _id: roomId,
            participants: socket.user.id
          }).lean();

          if (!room) {
            throw new Error('채팅방 접근 권한이 없습니다.');
          }

          // 5분간 캐시
          try {
            await redisClient.setex(roomCacheKey, 300, 'true');
          } catch (cacheError) {
            logError('room access cache write error', cacheError);
          }
        }

        // 로딩 상태 설정
        messageQueues.set(queueKey, Date.now());
        socket.emit('messageLoadStart');

        const result = await loadMessagesWithRetry(socket, roomId, before);
        
        logDebug('previous messages loaded', {
          roomId,
          messageCount: result.messages.length,
          hasMore: result.hasMore,
          oldestTimestamp: result.oldestTimestamp
        });

        socket.emit('previousMessagesLoaded', result);

      } catch (error) {
        logError('fetch previous messages error', error, { roomId, before });
        socket.emit('error', {
          type: 'LOAD_ERROR',
          message: error.message || '이전 메시지를 불러오는 중 오류가 발생했습니다.'
        });
      } finally {
        // 지연 후 큐에서 제거 (동시 요청 방지)
        setTimeout(() => {
          messageQueues.delete(queueKey);
        }, LOAD_DELAY);
      }
    });

    // ===== 채팅방 입장 처리 =====
    socket.on('joinRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 이미 해당 방에 참여 중인지 확인
        const currentRoom = userRooms.get(socket.user.id);
        if (currentRoom === roomId) {
          logDebug('already in room', {
            userId: socket.user.id,
            roomId
          });
          socket.emit('joinRoomSuccess', { roomId });
          return;
        }

        // 기존 방에서 나가기
        if (currentRoom) {
          socket.leave(currentRoom);
          userRooms.delete(socket.user.id);
          
          socket.to(currentRoom).emit('userLeft', {
            userId: socket.user.id,
            name: socket.user.name
          });
          
          logDebug('left previous room', {
            userId: socket.user.id,
            previousRoom: currentRoom
          });
        }

        // 채팅방 참가
        const room = await Room.findByIdAndUpdate(
          roomId,
          { $addToSet: { participants: socket.user.id } },
          { new: true, runValidators: true }
        ).populate('participants', 'name email profileImage');

        if (!room) {
          throw new Error('채팅방을 찾을 수 없습니다.');
        }

        socket.join(roomId);
        userRooms.set(socket.user.id, roomId);

        // 입장 메시지 생성 (비동기)
        const joinMessage = new Message({
          room: roomId,
          content: `${socket.user.name}님이 입장하였습니다.`,
          type: 'system',
          timestamp: new Date()
        });
        
        joinMessage.save().then(savedMessage => {
          io.to(roomId).emit('message', savedMessage);
        }).catch(err => {
          logError('join message save error', err);
        });

        // 초기 메시지 로드
        const messageLoadResult = await loadMessages(socket, roomId);
        const { messages, hasMore, oldestTimestamp } = messageLoadResult;

        // 활성 스트리밍 메시지 조회
        const activeStreams = Array.from(streamingSessions.values())
          .filter(session => session.room === roomId)
          .map(session => ({
            _id: session.messageId,
            type: 'ai',
            aiType: session.aiType,
            content: session.content,
            timestamp: session.timestamp,
            isStreaming: true
          }));

        // 이벤트 발송
        socket.emit('joinRoomSuccess', {
          roomId,
          participants: room.participants,
          messages,
          hasMore,
          oldestTimestamp,
          activeStreams
        });

        io.to(roomId).emit('participantsUpdate', room.participants);

        logDebug('user joined room', {
          userId: socket.user.id,
          roomId,
          messageCount: messages.length,
          hasMore,
          participantCount: room.participants.length
        });

      } catch (error) {
        logError('join room error', error, { roomId });
        socket.emit('joinRoomError', {
          message: error.message || '채팅방 입장에 실패했습니다.'
        });
      }
    });

    // ===== 메시지 전송 처리 =====
    socket.on('chatMessage', async ({ room, content, type = 'user', file, fileData }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!room || (!content && !file)) {
          throw new Error('메시지 내용이 필요합니다.');
        }

        // 레이트 리미팅 체크
        await checkRateLimit(socket.user.id);

        // AI 멘션 감지
        const aiMentions = [];
        if (content) {
          const mentionPattern = /@(wayneAI|consultingAI)\b/g;
          let match;
          while ((match = mentionPattern.exec(content)) !== null) {
            aiMentions.push(match[1]);
          }
        }

        const message = {
          sender: socket.user.id,
          room,
          content,
          type,
          file: fileData?._id || file || null,
          timestamp: new Date()
        };

        // 메시지 즉시 저장 및 전송 (배치 처리 대신)
        const newMessage = new Message(message);
        await newMessage.save();
        await newMessage.populate([
          { path: 'sender', select: 'name email profileImage' },
          { path: 'file', select: 'filename originalname mimetype size' }
        ]);

        // 모든 방 참여자에게 메시지 전송
        io.to(room).emit('message', newMessage);

        // AI 멘션 처리 (비동기)
        if (aiMentions.length > 0) {
          for (const ai of aiMentions) {
            const query = content.replace(new RegExp(`@${ai}\\b`, 'g'), '').trim();
            handleAIResponse(io, room, ai, query).catch(err => {
              logError('AI response error', err, { ai, query });
            });
          }
        }

        // 세션 활동 시간 업데이트 (비동기)
        SessionService.updateLastActivity(socket.user.id).catch(err => {
          logError('update last activity error', err);
        });

        logDebug('message sent successfully', {
          messageId: newMessage._id,
          room,
          type,
          hasAIMentions: aiMentions.length > 0
        });

      } catch (error) {
        logError('message handling error', error, { room, type });
        socket.emit('error', {
          code: error.code || 'MESSAGE_ERROR',
          message: error.message || '메시지 전송 중 오류가 발생했습니다.'
        });
      }
    });

    // ===== 메시지 읽음 상태 처리 =====
    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user || !Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        // 벌크 업데이트로 성능 향상
        const bulkOps = messageIds.map(messageId => ({
          updateOne: {
            filter: { 
              _id: messageId,
              room: roomId,
              'readers.userId': { $ne: socket.user.id }
            },
            update: {
              $push: {
                readers: {
                  userId: socket.user.id,
                  readAt: new Date()
                }
              }
            }
          }
        }));

        if (bulkOps.length > 0) {
          await Message.bulkWrite(bulkOps, { ordered: false });
        }

        socket.to(roomId).emit('messagesRead', {
          userId: socket.user.id,
          messageIds
        });

        logDebug('messages marked as read', {
          userId: socket.user.id,
          roomId,
          messageCount: messageIds.length
        });

      } catch (error) {
        logError('mark messages as read error', error, { roomId, messageCount: messageIds?.length });
        // 읽음 상태 업데이트 실패는 치명적이지 않으므로 클라이언트에 에러 전송하지 않음
      }
    });

    // ===== 리액션 처리 =====
    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const message = await Message.findById(messageId);
        if (!message) {
          throw new Error('메시지를 찾을 수 없습니다.');
        }

        // 리액션 추가/제거
        if (type === 'add') {
          await message.addReaction(reaction, socket.user.id);
        } else if (type === 'remove') {
          await message.removeReaction(reaction, socket.user.id);
        }

        // 업데이트된 리액션 정보 브로드캐스트
        io.to(message.room).emit('messageReactionUpdate', {
          messageId,
          reactions: message.reactions
        });

        logDebug('message reaction processed', {
          messageId,
          reaction,
          type,
          userId: socket.user.id
        });

      } catch (error) {
        logError('message reaction error', error, { messageId, reaction, type });
        socket.emit('error', {
          message: error.message || '리액션 처리 중 오류가 발생했습니다.'
        });
      }
    });

    // ===== 강제 로그인/로그아웃 처리 =====
    socket.on('force_login', async ({ token }) => {
      try {
        if (!socket.user) return;

        // 강제 로그아웃을 요청한 클라이언트의 세션 정보 확인
        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error('Invalid token');
        }

        // 세션 종료 처리
        socket.emit('session_ended', {
          reason: 'force_logout',
          message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
        });

        // 연결 종료
        socket.disconnect(true);

        logDebug('force login processed', {
          userId: socket.user.id,
          socketId: socket.id
        });

      } catch (error) {
        logError('force login error', error);
        socket.emit('error', {
          message: '세션 종료 중 오류가 발생했습니다.'
        });
      }
    });

    // ===== 사용자 상태 업데이트 =====
    socket.on('updateUserStatus', async ({ status }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 유효한 상태 값 확인
        const validStatuses = ['online', 'away', 'busy', 'offline'];
        if (!validStatuses.includes(status)) {
          throw new Error('Invalid status');
        }

        // 현재 사용자가 참여 중인 방에 상태 업데이트 브로드캐스트
        const currentRoom = userRooms.get(socket.user.id);
        if (currentRoom) {
          socket.to(currentRoom).emit('userStatusUpdate', {
            userId: socket.user.id,
            status
          });
        }

        logDebug('user status updated', {
          userId: socket.user.id,
          status,
          room: currentRoom
        });

      } catch (error) {
        logError('update user status error', error);
        socket.emit('error', {
          message: '상태 업데이트 중 오류가 발생했습니다.'
        });
      }
    });

    // ===== 타이핑 상태 처리 =====
    socket.on('typing', ({ roomId, isTyping }) => {
      try {
        if (!socket.user || !roomId) return;

        socket.to(roomId).emit('userTyping', {
          userId: socket.user.id,
          name: socket.user.name,
          isTyping
        });

        // 타이핑 상태는 로그하지 않음 (너무 빈번함)
      } catch (error) {
        logError('typing status error', error);
      }
    });

    // ===== 연결 해제 처리 =====
    socket.on('disconnect', async (reason) => {
      if (!socket.user) return;

      try {
        const userId = socket.user.id;
        const userName = socket.user.name;

        // 해당 사용자의 현재 활성 연결인 경우에만 정리
        if (connectedUsers.get(userId) === socket.id) {
          connectedUsers.delete(userId);
        }

        const roomId = userRooms.get(userId);
        if (roomId) {
          userRooms.delete(userId);
        }

        // 관련 큐와 세션 정리
        const userQueues = Array.from(messageQueues.keys())
          .filter(key => key.includes(userId));
        userQueues.forEach(key => {
          messageQueues.delete(key);
        });
        
        // 스트리밍 세션 정리
        for (const [messageId, session] of streamingSessions.entries()) {
          if (session.userId === userId) {
            streamingSessions.delete(messageId);
          }
        }

        // 레이트 리미트 캐시에서 해당 사용자 관련 항목 정리
        const rateLimitKeys = Array.from(rateLimitCache.keys())
          .filter(key => key.startsWith(userId));
        rateLimitKeys.forEach(key => {
          rateLimitCache.delete(key);
        });

        // 퇴장 메시지 처리 (중복 로그인이 아닌 경우만)
        if (roomId && reason !== 'client namespace disconnect' && reason !== 'duplicate_login') {
          const leaveMessage = new Message({
            room: roomId,
            content: `${userName}님이 연결이 끊어졌습니다.`,
            type: 'system',
            timestamp: new Date()
          });

          // 비동기 처리
          Promise.all([
            leaveMessage.save(),
            Room.findByIdAndUpdate(
              roomId,
              { $pull: { participants: userId } },
              { new: true, runValidators: true }
            ).populate('participants', 'name email profileImage')
          ]).then(([savedMessage, updatedRoom]) => {
            if (updatedRoom) {
              io.to(roomId).emit('message', savedMessage);
              io.to(roomId).emit('participantsUpdate', updatedRoom.participants);
            }
          }).catch(err => {
            logError('disconnect message handling error', err);
          });
        }

        logDebug('user disconnected', {
          reason,
          userId,
          socketId: socket.id,
          lastRoom: roomId,
          cleanedQueues: userQueues.length,
          cleanedRateLimits: rateLimitKeys.length
        });

      } catch (error) {
        logError('disconnect handling error', error, {
          userId: socket.user?.id,
          reason
        });
      }
    });

    // ===== 에러 처리 =====
    socket.on('error', (error) => {
      logError('socket error', error, {
        socketId: socket.id,
        userId: socket.user?.id
      });
    });
  });

  // ===== AI 응답 처리 함수 =====
  const handleAIResponse = async (io, roomId, aiType, query) => {
    try {
      if (!aiService || typeof aiService.generateResponse !== 'function') {
        logError('AI service not available', new Error('AI service not configured'));
        return;
      }

      const sessionId = `${roomId}_${aiType}_${Date.now()}`;
      
      // 스트리밍 세션 생성
      streamingSessions.set(sessionId, {
        room: roomId,
        aiType,
        content: '',
        timestamp: new Date(),
        lastActivity: Date.now()
      });

      // AI 응답 시작 알림
      io.to(roomId).emit('aiMessageStart', {
        sessionId,
        aiType,
        timestamp: new Date()
      });

      // AI 서비스 호출 및 스트리밍 처리
      await aiService.generateResponse(query, aiType, {
        onChunk: (chunk) => {
          const session = streamingSessions.get(sessionId);
          if (session) {
            session.content += chunk;
            session.lastActivity = Date.now();
            
            io.to(roomId).emit('aiMessageChunk', {
              sessionId,
              chunk,
              fullContent: session.content
            });
          }
        },
        onComplete: async (finalContent) => {
          try {
            // 최종 메시지 저장
            const aiMessage = new Message({
              room: roomId,
              content: finalContent,
              type: 'ai',
              aiType,
              timestamp: new Date()
            });

            await aiMessage.save();
            await aiMessage.populate('sender', 'name email profileImage');

            // 완료 알림
            io.to(roomId).emit('aiMessageComplete', {
              sessionId,
              message: aiMessage
            });

            // 스트리밍 세션 정리
            streamingSessions.delete(sessionId);

            logDebug('AI response completed', {
              sessionId,
              aiType,
              contentLength: finalContent.length
            });

          } catch (saveError) {
            logError('AI message save error', saveError, { sessionId });
            streamingSessions.delete(sessionId);
          }
        },
        onError: (error) => {
          logError('AI response error', error, { sessionId, aiType });
          
          io.to(roomId).emit('aiMessageError', {
            sessionId,
            error: 'AI 응답 생성 중 오류가 발생했습니다.'
          });

          streamingSessions.delete(sessionId);
        }
      });

    } catch (error) {
      logError('handle AI response error', error, { roomId, aiType });
    }
  };

  // ===== 프로세스 종료 시 정리 =====
  const cleanup = () => {
    try {
      clearInterval(memoryCleanup);
      // clearInterval(bufferFlushInterval); // 배치 처리 제거로 불필요
      
      console.log('Chat socket server cleanup completed');
    } catch (error) {
      logError('cleanup error', error);
    }
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('beforeExit', cleanup);

  // ===== 성능 모니터링 =====
  setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const connections = connectedUsers.size;
    
    // 성능 지표 로깅
    console.log(`[PERFORMANCE] Heap: ${heapUsedMB}MB, Connections: ${connections}, Buffer: ${messageBuffer.length}`);
    
    // 성능 통계
    const stats = {
      memory: {
        heapUsed: heapUsedMB,
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024)
      },
      connections: {
        active: connections,
        rooms: userRooms.size,
        streaming: streamingSessions.size
      },
      cache: {
        messageQueues: messageQueues.size,
        rateLimitCache: rateLimitCache.size,
        hitRates: {
          connectedUsers: connectedUsers.getStats().hitRate,
          rateLimitCache: rateLimitCache.getStats().hitRate
        }
      },
      buffer: {
        pendingMessages: 0, // messageBuffer.length, // 배치 처리 제거
        maxSize: 0 // BUFFER_SIZE // 배치 처리 제거
      }
    };

    // 경고 임계값 체크
    if (heapUsedMB > 1000) {
      console.warn(`[WARNING] High memory usage: ${heapUsedMB}MB`);
    }
    
    if (connections > 250) {
      console.warn(`[WARNING] High connection count: ${connections}`);
    }
    
    // 배치 처리 제거로 경고문 삭제
    
    // 개발 모드에서는 상세 통계 출력
    if (process.env.NODE_ENV === 'development') {
      logDebug('performance stats', stats);
    }
    
  }, 30000); // 30초마다

  // ===== 초기화 완료 로그 =====
  console.log('🚀 Optimized chat socket server initialized');
  console.log(`📊 Configuration: ${BATCH_SIZE} batch size, ${RATE_LIMIT_MAX}/min rate limit`);
  console.log(`💾 Memory limits: ${connectedUsers.maxSize} users, ${streamingSessions.maxSize} streams`);
  console.log(`⚡ Performance optimizations: caching, immediate processing, compression enabled`);
};