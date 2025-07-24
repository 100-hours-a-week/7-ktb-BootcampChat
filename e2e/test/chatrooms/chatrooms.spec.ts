import { test, expect } from '@playwright/test';
import { TestHelpers } from '../helpers/test-helpers';

test.describe('메시징 테스트', () => {
  const helpers = new TestHelpers();

  test('여러 사용자간 실시간 채팅', async ({ browser }) => {
    const roomPrefix = 'Chat';
    
    // 병렬로 사용자 생성 및 등록
    const [user1, user2, user3] = await Promise.all([
      browser.newPage(),
      browser.newPage(),
      browser.newPage()
    ]);

    const users = [user1, user2, user3];
    const credentials = users.map((_, i) => helpers.generateUserCredentials(i + 1));

    // 각 사용자 등록
    await Promise.all([
      helpers.registerUser(user1, credentials[0]),
      helpers.registerUser(user2, credentials[1]),
      helpers.registerUser(user3, credentials[2])
    ]);

    // 첫 번째 사용자가 방 생성 및 정확한 방 이름 저장
    const createdRoomName = await helpers.joinOrCreateRoom(user1, roomPrefix);
    console.log(`Created room name: ${createdRoomName}`);

    // 생성된 방의 URL 파라미터 확인
    const hostUrl = user1.url();
    const roomParam = new URLSearchParams(new URL(hostUrl).search).get('room');
    
    if (!roomParam) {
      throw new Error('Failed to get room name from URL');
    }

    // 나머지 사용자들이 같은 방으로 입장
    await helpers.joinRoomByURLParam(user2, roomParam);
    await helpers.joinRoomByURLParam(user3, roomParam);

    // 모든 사용자가 동일한 채팅방에 있는지 확인
    for (const user of users) {
      const userHostUrl = user.url();
    	const userRoomParam = new URLSearchParams(new URL(userHostUrl).search).get('room');
      expect(userRoomParam).toBe(roomParam);
    }

    // 각 사용자마다 채팅창이 로드될 때까지 대기
    await Promise.all(users.map(async user => {
      // 채팅 컨테이너가 표시될 때까지 대기
      await user.waitForLoadState('networkidle');
      await user.waitForSelector('.chat-container', { 
        state: 'visible',
        timeout: 30000 
      });
      
      // 채팅 입력창이 활성화될 때까지 대기
      await user.waitForLoadState('networkidle');
      await user.waitForSelector('.chat-input-textarea:not([disabled])', {
        state: 'visible',
        timeout: 30000
      });
    }));

    // 메시지 전송 및 검증
    const messages = [
      { user: user1, text: `안녕하세요! ${credentials[0].name}입니다.` },
      { user: user2, text: `반갑습니다! ${credentials[1].name}입니다.` },
      { user: user3, text: `안녕하세요~ ${credentials[2].name}입니다!` }
    ];

    // 메시지를 순차적으로 전송하고 각각 확인
    for (const { user, text } of messages) {
      await helpers.sendMessage(user, text);
      
      // 모든 사용자의 화면에서 메시지가 표시되는지 확인
      await Promise.all(users.map(async viewer => {
        // 더 안전한 선택자 사용
        try {
          await viewer.waitForSelector(`.message-content:has-text("${text}")`, {
            timeout: 10000
          });
        } catch (e1) {
          // fallback: 텍스트가 포함된 모든 요소 찾기
          try {
            await viewer.waitForSelector(`text=${text}`, {
              timeout: 5000
            });
          } catch (e2) {
            // 디버깅: 현재 페이지의 모든 메시지 내용 출력
            const allMessages = await viewer.$$eval('.message-content', els => 
              els.map(el => el.textContent?.trim()).filter(Boolean)
            );
            console.log(`사용자 화면의 모든 메시지:`, allMessages);
            console.log(`찾으려는 메시지: "${text}"`);
            throw new Error(`메시지를 찾을 수 없음: "${text}"`);
          }
        }
      }));
    }

    // AI 호출 및 응답 확인
    await helpers.sendAIMessage(user1, '우리 대화에 대해 요약해줄 수 있나요?');
    await Promise.all(users.map(async user => {
      await user.waitForSelector('.message-ai', {
        timeout: 20000
      });
    }));

    // 테스트 종료 전 채팅방 확인 - URL 파라미터 대신 실제 방 이름 확인
    for (const user of users) {
      const finalRoomName = await user.locator('.chat-room-title').textContent();
      expect(finalRoomName).toBe(createdRoomName); // roomParam -> createdRoomName으로 변경
    }

    // 리소스 정리
    await Promise.all(users.map(user => user.close()));
  });

  test.skip('파일 공유 및 이모지 반응', async ({ browser }) => {
    const roomPrefix = 'FileShare';
    
    // 첫 번째 사용자 설정
    const user1 = await browser.newPage();
    const user1Creds = helpers.getTestUser(Math.floor(Math.random() * 1001));
    await helpers.registerUser(user1, user1Creds);
    
    // 방 생성 및 정확한 방 이름 저장
    const createdRoomName = await helpers.joinOrCreateRoom(user1, roomPrefix);
    console.log(`Created room name: ${createdRoomName}`);

    // 생성된 방의 URL 파라미터 확인
    const hostUrl = user1.url();
    const roomParam = new URLSearchParams(new URL(hostUrl).search).get('room');
    
    if (!roomParam) {
      throw new Error('Failed to get room name from URL');
    }
    
    // 두 번째 사용자 설정 및 같은 방으로 입장
    const user2 = await browser.newPage();
    const user2Creds = helpers.getTestUser(1);
    await helpers.registerUser(user2, user2Creds);
    await helpers.joinRoomByURLParam(user2, roomParam);

    // 양쪽 모두 동일한 채팅방에 있는지 확인
    for (const user of [user1, user2]) {
      const userHostUrl = user.url();
    	const userRoomParam = new URLSearchParams(new URL(userHostUrl).search).get('room');
      expect(userRoomParam).toBe(roomParam);
    }

    // 메시지 전송 및 대기
    const testMessage = '이 메시지에 반응해보세요!';
    await user2.waitForSelector('.chat-input-textarea:not([disabled])', { timeout: 30000 });
    await helpers.sendMessage(user1, testMessage);

    // user1 화면에서 메시지 표시 확인
    try {
      await user1.waitForSelector(`.message-content:has-text("${testMessage}")`, {
        state: 'visible',
        timeout: 10000
      });
    } catch (e1) {
      // fallback: 텍스트가 포함된 모든 요소 찾기
      try {
        await user1.waitForSelector(`text=${testMessage}`, {
          timeout: 5000
        });
      } catch (e2) {
        // 디버깅: user1 화면의 모든 메시지 내용 출력
        const allMessages = await user1.$$eval('.message-content', els => 
          els.map(el => el.textContent?.trim()).filter(Boolean)
        );
        console.log(`user1 화면의 모든 메시지:`, allMessages);
        console.log(`찾으려는 메시지: "${testMessage}"`);
        throw new Error(`user1에서 메시지를 찾을 수 없음: "${testMessage}"`);
      }
    }

    // user2 화면에서 메시지 표시 확인
         try {
       await user2.waitForSelector(`.message-content:has-text("${testMessage}")`, {
         state: 'visible',
         timeout: 30000
       });
     } catch (e1) {
       // fallback: 텍스트가 포함된 모든 요소 찾기
       try {
         await user2.waitForSelector(`text=${testMessage}`, {
           timeout: 5000
         });
       } catch (e2) {
         // 디버깅용: user2 화면의 모든 메시지 출력
         const allMessages = await user2.$$eval('.message-content', els => 
           els.map(el => el.textContent?.trim()).filter(Boolean)
         );
         console.log('user2가 받은 메시지 목록:', allMessages);
         console.log(`찾으려는 메시지: "${testMessage}"`);
         await user2.screenshot({ path: 'user2-message-debug.png', fullPage: true });
         throw new Error(`user2에서 메시지를 찾을 수 없음: "${testMessage}"`);
       }
     }

    // 메시지 액션 영역이 로드될 때까지 대기
    await user2.waitForSelector('.message-actions', {
      state: 'visible',
      timeout: 30000
    });

    // 메시지에 호버하여 액션 버튼 표시
    const messageElement = user2.locator('.message-actions').last();
    await messageElement.hover();
    
    // 반응 버튼이 나타날 때까지 대기 후 클릭
    try {
      const actionButton = messageElement.locator('button[aria-label="리액션 추가"]');
      await actionButton.waitFor({ state: 'visible', timeout: 30000 });
      await actionButton.click();
    } catch (e) {
      // 디버깅: 메시지 액션 요소들 확인
      const actionElements = await user2.$$eval('.message-actions', els => 
        els.map(el => ({
          innerHTML: el.innerHTML,
          className: el.className,
          visible: (el as HTMLElement).offsetHeight > 0
        }))
      );
      console.log('메시지 액션 요소들:', actionElements);
      
      // 모든 button 요소 확인
      const allButtons = await user2.$$eval('button', els => 
        els.map(el => ({
          title: el.title,
          textContent: el.textContent?.trim(),
          className: el.className,
          visible: (el as HTMLElement).offsetHeight > 0
        })).filter(btn => btn.visible)
      );
      console.log('화면의 모든 버튼들:', allButtons);
      
      throw new Error(`리액션 버튼을 찾을 수 없음: ${e.message}`);
    }

    // 이모지 피커가 나타날 때까지 대기
    await user2.waitForSelector('.emoji-picker-container', { timeout: 10000 });
    
    // 이모지 피커의 첫 번째 이모지 선택
    const emojiButton = user2.locator('.emoji-picker-container button').first();
    await emojiButton.waitFor({ state: 'visible', timeout: 5000 });
    console.log('이모지 버튼 클릭 시도');
    await emojiButton.click();
    console.log('이모지 버튼 클릭 완료');
    
    // 잠시 대기하여 반응이 처리될 시간을 줌
    await user2.waitForTimeout(2000);
    
    // 반응이 표시되는지 확인
    try {
      await Promise.all([
        user1.waitForSelector('.reaction-badge', { timeout: 30000 }),
        user2.waitForSelector('.reaction-badge', { timeout: 30000 })
      ]);
    } catch (error) {
      // 디버깅: 반응이 나타나지 않을 경우 DOM 상태 확인
      console.log('반응 배지를 찾을 수 없음. DOM 상태 확인 중...');
      
      const user1Messages = await user1.$$eval('.message-actions', els => 
        els.map(el => ({
          innerHTML: el.innerHTML,
          className: el.className,
          visible: (el as HTMLElement).offsetHeight > 0
        }))
      );
      console.log('user1의 메시지 액션들:', user1Messages);
      
      const user2Messages = await user2.$$eval('.message-actions', els => 
        els.map(el => ({
          innerHTML: el.innerHTML,
          className: el.className,
          visible: (el as HTMLElement).offsetHeight > 0
        }))
      );
      console.log('user2의 메시지 액션들:', user2Messages);
      
      // 스크린샷 추가 촬영
      await user1.screenshot({ path: 'debug-user1-reactions.png', fullPage: true });
      await user2.screenshot({ path: 'debug-user2-reactions.png', fullPage: true });
      
      throw error;
    }

    // 테스트 종료 전 채팅방 확인
    for (const user of [user1, user2]) {
      const finalRoomName = await user.locator('.chat-room-title').textContent();
      expect(finalRoomName).toBe(createdRoomName);
    }

    // 리소스 정리
    await Promise.all([user1.close(), user2.close()]);
  });
});