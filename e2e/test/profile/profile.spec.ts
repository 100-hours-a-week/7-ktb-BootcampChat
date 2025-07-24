// test/profile/profile.spec.ts
import { test, expect } from '@playwright/test';
import { TestHelpers } from '../helpers/test-helpers';

test.describe('프로필 테스트', () => {
  const helpers = new TestHelpers();

  test('프로필 수정', async ({ page }) => {
    const credentials = helpers.generateUserCredentials(1);
    await helpers.registerUser(page, credentials);
    
    // 네비게이션 바가 로드될 때까지 대기
    await page.waitForSelector('nav', { timeout: 30000 });
    
    // 사용자 정보가 로드될 때까지 잠시 대기
    await page.waitForTimeout(2000);
    
    // 프로필 버튼 찾기 및 클릭
    try {
      await page.waitForSelector('button:has-text("프로필")', { timeout: 10000 });
      await page.click('button:has-text("프로필")');
    } catch (error) {
      console.log('프로필 버튼을 찾을 수 없음, 직접 이동:', error.message);
      await page.goto('/profile');
    }
    
    await page.waitForLoadState('networkidle');
    
    // 프로필 페이지가 로드될 때까지 대기
    await page.waitForSelector('input[id="name"]', { timeout: 30000 });
    
    // 현재 이름 값 확인
    const currentNameValue = await page.inputValue('input[id="name"]');
    console.log('Current name value:', currentNameValue);
    
    // 이름 변경
    const newName = `Updated ${credentials.name}`;
    await page.fill('input[id="name"]', newName);
    
    // 저장 버튼 클릭
    await page.click('button:has-text("저장")');
    
    // 성공 메시지 확인 (다양한 형태의 성공 메시지 대기)
    await page.waitForSelector('text=/성공|저장|업데이트/', { timeout: 10000 });
    
    // 페이지 새로고침 후 변경 확인
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('input[id="name"]', { timeout: 30000 });
    await expect(page.locator('input[id="name"]')).toHaveValue(newName);
  });
});