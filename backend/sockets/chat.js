// backend/sockets/chat.js - 기존 구조 유지하면서 최적화만 적용
const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const File = require('../models/File');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const SessionService = require('../services/sessionService');

module.exports = function(io) {
  // 기본 데이터 구조 (간단하게 유지)
  const connectedUsers = new Map();
  const streamingSessions = new Map();
  const userRooms = new Map();
  const messageQueues = new Map();
  const messageLoadRetries = new Map();
  
  // 기본 상수
  const BATCH_SIZE = 30;
  const LOAD_DELAY = 300;
  const MAX_RETRIES = 3;
  const MESSAGE_LOAD_TIMEOUT = 10000;
  const RETRY_DELAY = 2000;
  const DUPLICATE_LOGIN_TIMEOUT = 10000;

  // 로깅 함수
  const logDebug = (action, data) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[Socket.IO] ${action}:`, {
        ...data,
        timestamp: new Date().toISOString()
      });
    }
  };

  // 간단한 메시지 로드 함수
  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    try {
      const query = { room: roomId };
      if (before) {
        query.timestamp = { $lt: new Date(before) };
      }

      const messages = await Message.find(query)
        .populate('sender', 'name email profileImage')
        .populate({
          path: 'file',
          select: 'filename originalname mimetype size'
        })
        .sort({ timestamp: -1 })
        .limit(limit + 1)
        .lean();

      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const sortedMessages = resultMessages.sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );

      // 읽음 상태 업데이트 (비동기)
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
          console.error('Read status update error:', err);
        });
      }

      return {
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages.length > 0 ? sortedMessages[0].timestamp : null
      };

    } catch (error) {
      console.error('Load messages error:', error);
      throw error;
    }
  };

  // 중복 로그인 처리
  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      existingSocket.emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: newSocket.handshake.headers['user-agent'],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now()
      });

      return new Promise((resolve) => {
        setTimeout(() => {
          try {
            existingSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });
            existingSocket.disconnect(true);
          } catch (error) {
            console.error('Error during session termination:', error);
          } finally {
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      console.error('Duplicate login handling error:', error);
      throw error;
    }
  };

  // Socket.IO 미들웨어 - 인증 처리
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

      // 중복 로그인 체크
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
        console.error('Session validation failed:', validationResult);
        return next(new Error(validationResult.message || 'Invalid session'));
      }

      const user = await User.findById(decoded.user.id).lean();
      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage
      };

      SessionService.updateLastActivity(decoded.user.id).catch(err => {
        console.error('Update last activity error:', err);
      });

      next();

    } catch (error) {
      console.error('Socket authentication error:', error);
      
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Token expired'));
      }
      
      if (error.name === 'JsonWebTokenError') {
        return next(new Error('Invalid token'));
      }
      
      next(new Error('Authentication failed'));
    }
  });

  // Socket 연결 처리
  io.on('connection', (socket) => {
    logDebug('socket connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name
    });

    if (socket.user) {
      connectedUsers.set(socket.user.id, socket.id);
    }

    // 이전 메시지 로딩
    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}`;

      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (messageQueues.has(queueKey)) {
          logDebug('message load skipped - already loading', { roomId, userId: socket.user.id });
          return;
        }

        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id
        });

        if (!room) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        messageQueues.set(queueKey, Date.now());
        socket.emit('messageLoadStart');

        const result = await loadMessages(socket, roomId, before);
        
        logDebug('previous messages loaded', {
          roomId,
          messageCount: result.messages.length,
          hasMore: result.hasMore
        });

        socket.emit('previousMessagesLoaded', result);

      } catch (error) {
        console.error('Fetch previous messages error:', error);
        socket.emit('error', {
          type: 'LOAD_ERROR',
          message: error.message || '이전 메시지를 불러오는 중 오류가 발생했습니다.'
        });
      } finally {
        setTimeout(() => {
          messageQueues.delete(queueKey);
        }, LOAD_DELAY);
      }
    });

    // 채팅방 입장
    socket.on('joinRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const currentRoom = userRooms.get(socket.user.id);
        if (currentRoom === roomId) {
          socket.emit('joinRoomSuccess', { roomId });
          return;
        }

        if (currentRoom) {
          socket.leave(currentRoom);
          userRooms.delete(socket.user.id);
          
          socket.to(currentRoom).emit('userLeft', {
            userId: socket.user.id,
            name: socket.user.name
          });
        }

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

        // 입장 메시지
        const joinMessage = new Message({
          room: roomId,
          content: `${socket.user.name}님이 입장하였습니다.`,
          type: 'system',
          timestamp: new Date()
        });
        
        joinMessage.save().then(savedMessage => {
          io.to(roomId).emit('message', savedMessage);
        }).catch(err => {
          console.error('Join message save error:', err);
        });

        // 초기 메시지 로드
        const messageLoadResult = await loadMessages(socket, roomId);

        socket.emit('joinRoomSuccess', {
          roomId,
          participants: room.participants,
          messages: messageLoadResult.messages,
          hasMore: messageLoadResult.hasMore,
          oldestTimestamp: messageLoadResult.oldestTimestamp
        });

        io.to(roomId).emit('participantsUpdate', room.participants);

        logDebug('user joined room', {
          userId: socket.user.id,
          roomId,
          messageCount: messageLoadResult.messages.length
        });

      } catch (error) {
        console.error('Join room error:', error);
        socket.emit('joinRoomError', {
          message: error.message || '채팅방 입장에 실패했습니다.'
        });
      }
    });

    // ⭐ 핵심: 메시지 전송 처리 (프론트엔드 이벤트명과 일치)
    socket.on('chatMessage', async ({ room, content, type = 'text', fileData }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!room || (!content && !fileData)) {
          throw new Error('메시지 내용이 필요합니다.');
        }

        console.log('[Socket] Received chatMessage:', { room, content, type, fileData });

        // AI 멘션 감지
        const aiMentions = [];
        if (content) {
          const mentionPattern = /@(wayneAI|consultingAI)\b/g;
          let match;
          while ((match = mentionPattern.exec(content)) !== null) {
            aiMentions.push(match[1]);
          }
        }

        // 메시지 객체 생성
        const messageData = {
          sender: socket.user.id,
          room,
          content,
          type,
          timestamp: new Date()
        };

        // 파일 데이터가 있으면 추가
        if (fileData && fileData._id) {
          messageData.file = fileData._id;
          messageData.type = 'file';
        }

        // DB에 저장
        const message = new Message(messageData);
        await message.save();
        
        // Populate
        await message.populate([
          { path: 'sender', select: 'name email profileImage' },
          { path: 'file', select: 'filename originalname mimetype size' }
        ]);

        // 모든 방 참여자에게 전송
        io.to(room).emit('message', message);

        // AI 멘션 처리 (비동기)
        if (aiMentions.length > 0) {
          // AI 처리 로직 (나중에 구현)
          console.log('AI mentions detected:', aiMentions);
        }

        SessionService.updateLastActivity(socket.user.id).catch(err => {
          console.error('Update last activity error:', err);
        });

        logDebug('message sent successfully', {
          messageId: message._id,
          room,
          type,
          hasAIMentions: aiMentions.length > 0
        });

      } catch (error) {
        console.error('Message handling error:', error);
        socket.emit('error', {
          code: error.code || 'MESSAGE_ERROR',
          message: error.message || '메시지 전송 중 오류가 발생했습니다.'
        });
      }
    });

    // 메시지 읽음 상태
    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user || !Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

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

      } catch (error) {
        console.error('Mark messages as read error:', error);
      }
    });

    // 연결 해제 처리
    socket.on('disconnect', async (reason) => {
      if (!socket.user) return;

      try {
        const userId = socket.user.id;
        const userName = socket.user.name;

        if (connectedUsers.get(userId) === socket.id) {
          connectedUsers.delete(userId);
        }

        const roomId = userRooms.get(userId);
        if (roomId) {
          userRooms.delete(userId);
        }

        // 관련 큐 정리
        const userQueues = Array.from(messageQueues.keys())
          .filter(key => key.includes(userId));
        userQueues.forEach(key => {
          messageQueues.delete(key);
        });

        // 퇴장 메시지 (중복 로그인이 아닌 경우)
        if (roomId && reason !== 'client namespace disconnect' && reason !== 'duplicate_login') {
          const leaveMessage = new Message({
            room: roomId,
            content: `${userName}님이 연결이 끊어졌습니다.`,
            type: 'system',
            timestamp: new Date()
          });

          Promise.all([
            leaveMessage.save(),
            Room.findByIdAndUpdate(
              roomId,
              { $pull: { participants: userId } },
              { new: true }
            ).populate('participants', 'name email profileImage')
          ]).then(([savedMessage, updatedRoom]) => {
            if (updatedRoom) {
              io.to(roomId).emit('message', savedMessage);
              io.to(roomId).emit('participantsUpdate', updatedRoom.participants);
            }
          }).catch(err => {
            console.error('Disconnect message handling error:', err);
          });
        }

        logDebug('user disconnected', {
          reason,
          userId,
          socketId: socket.id,
          lastRoom: roomId
        });

      } catch (error) {
        console.error('Disconnect handling error:', error);
      }
    });
  });

  console.log('🚀 Simple optimized chat socket server initialized');
};