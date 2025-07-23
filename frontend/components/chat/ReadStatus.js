import React, { useMemo, useEffect, useState, useCallback, useRef } from 'react';
import { ConfirmOutlineIcon } from '@vapor-ui/icons';
import { Text } from '@vapor-ui/core';

const ReadStatus = ({ 
  messageType = 'text',
  participants = [],
  readers = [],
  className = '',
  socketRef = null,
  messageId = null,
  messageRef = null,
  currentUserId = null
}) => {
  const [currentReaders, setCurrentReaders] = useState(readers || []);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [hasMarkedAsRead, setHasMarkedAsRead] = useState(false);
  const statusRef = useRef(null);
  const observerRef = useRef(null);

  // 읽지 않은 참여자 명단 생성 
  const unreadParticipants = useMemo(() => {
    if (messageType === 'system') return [];
    
    return participants.filter(participant => 
      !currentReaders.some(reader => 
        reader.userId === participant._id || 
        reader.userId === participant.id
      )
    );
  }, [participants, currentReaders, messageType]);

  // 읽지 않은 참여자 수 계산
  const unreadCount = useMemo(() => {
    if (messageType === 'system') {
      return 0;
    }
    return unreadParticipants.length;
  }, [unreadParticipants.length, messageType]);

  // 메시지를 읽음으로 표시하는 함수 - dependency 최소화
  const markMessageAsRead = useCallback(async () => {
    if (!messageId || !currentUserId || hasMarkedAsRead || 
        messageType === 'system' || !socketRef?.current) {
      return;
    }

    try {
      // Socket.IO를 통해 서버에 읽음 상태 전송
      socketRef.current.emit('markMessagesAsRead', {
        messageIds: [messageId]
      });

      setHasMarkedAsRead(true);

      // 현재 사용자를 읽은 목록에 추가
      setCurrentReaders(prev => {
        if (prev.some(reader => reader.userId === currentUserId)) {
          return prev;
        }
        return [...prev, {
          userId: currentUserId,
          readAt: new Date()
        }];
      });

    } catch (error) {
      console.error('Error marking message as read:', error);
    }
  }, [messageId, currentUserId, hasMarkedAsRead, messageType]); // socketRef 제거

  // 툴팁 텍스트 생성
  const getTooltipText = useCallback(() => {
    if (unreadCount === 0) return "모두 읽음";
    const unreadNames = unreadParticipants.map(p => p.name);
    return `${unreadNames.join(', ')}이 읽지 않음`;
  }, [unreadCount, unreadParticipants]);

  // 읽음 상태 업데이트 핸들러
  const handleReadStatusUpdate = useCallback(({ userId, messageIds, timestamp }) => {
    if (!messageId || !messageIds.includes(messageId)) return;

    setCurrentReaders(prev => {
      if (prev.some(reader => reader.userId === userId)) {
        return prev;
      }
      
      return [...prev, { 
        userId, 
        readAt: timestamp || new Date()
      }];
    });
  }, [messageId]);

  // 참여자 업데이트 핸들러
  const handleParticipantsUpdate = useCallback((updatedParticipants) => {
    setCurrentReaders(prev => 
      prev.filter(reader => 
        updatedParticipants.some(p => 
          p._id === reader.userId || p.id === reader.userId
        )
      )
    );
  }, []);

  // props나 참여자 변경 시 readers 업데이트
  useEffect(() => {
    setCurrentReaders(readers);
  }, [readers]);

  // Socket.IO 이벤트 리스너 설정
  useEffect(() => {
    if (!socketRef?.current) return;

    const socket = socketRef.current; // 로컬 변수로 저장

    socket.on('messagesRead', handleReadStatusUpdate);
    socket.on('participantsUpdate', handleParticipantsUpdate);

    return () => {
      socket.off('messagesRead', handleReadStatusUpdate);
      socket.off('participantsUpdate', handleParticipantsUpdate);
    };
  }, [handleReadStatusUpdate, handleParticipantsUpdate]); // socketRef 제거

  // Intersection Observer 설정 - dependency 최소화
  useEffect(() => {
    if (!messageRef?.current || !currentUserId || hasMarkedAsRead || messageType === 'system') {
      return;
    }

    // 이미 읽은 메시지인지 확인
    const isAlreadyRead = currentReaders.some(reader => 
      reader.userId === currentUserId
    );

    if (isAlreadyRead) {
      setHasMarkedAsRead(true);
      return;
    }

    const observerOptions = {
      root: null,
      rootMargin: '0px',
      threshold: 0.5
    };

    const handleIntersect = (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && !hasMarkedAsRead) {
          // socketRef 직접 확인
          if (socketRef?.current) {
            markMessageAsRead();
          }
        }
      });
    };

    const observer = new IntersectionObserver(handleIntersect, observerOptions);
    observer.observe(messageRef.current);

    // ref에 observer 저장
    observerRef.current = observer;

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [messageRef, currentUserId, hasMarkedAsRead, messageType, currentReaders]); // markMessageAsRead 제거

  const toggle = () => setTooltipOpen(prev => !prev);

  // 시스템 메시지는 읽음 상태 표시 안 함
  if (messageType === 'system') {
    return null;
  }

  // 모두 읽은 경우
  if (unreadCount === 0) {
    return (
      <div 
        className={`read-status ${className}`}
        ref={statusRef}
        role="status"
        aria-label="모든 참여자가 메시지를 읽었습니다"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <ConfirmOutlineIcon size={12} style={{ color: 'var(--vapor-color-success)' }} />
            <ConfirmOutlineIcon size={12} style={{ color: 'var(--vapor-color-success)', marginLeft: '-6px' }} />
          </div>
          <Text typography="caption" style={{ fontSize: '0.65rem', color: 'var(--vapor-color-text-muted)' }}>모두 읽음</Text>
        </div>
      </div>
    );
  }

  // 읽지 않은 사람이 있는 경우
  return (
    <div 
      className={`read-status ${className}`}
      ref={statusRef}
      role="status"
      aria-label={`${unreadCount}명이 메시지를 읽지 않았습니다`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <ConfirmOutlineIcon size={12} style={{ color: 'var(--vapor-color-gray-400)' }} />
        {unreadCount > 0 && (
          <Text typography="caption" style={{ fontSize: '0.65rem', color: 'var(--vapor-color-text-muted)' }}>
            {unreadCount}명 안 읽음
          </Text>
        )}
      </div>
    </div>
  );
};

ReadStatus.displayName = 'ReadStatus';

export default React.memo(ReadStatus);