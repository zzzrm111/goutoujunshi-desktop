import { expect, test } from "@playwright/test";

const profile = {
  id: "local-agent",
  display_name: "小满",
  personality: "温柔、俏皮，有自己的主见",
  background: "喜欢读书和听歌",
  interests: "音乐、散步、电影",
  boundaries: "不接受羞辱、威胁和欺骗",
  speech_style: "自然、口语化、短句",
  autonomy_level: 4,
  anger_sensitivity: 3,
  silent_duration_minutes: 30,
  updated_at: "2026-10-10T00:00:00Z",
};

test("can enter girlfriend chat and receive a streamed reply", async ({ page }) => {
  let adultConfirmed = false;
  let sessionCreated = false;
  let ttsRequested = false;

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/v1/sessions" && request.method() === "GET") {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === "/api/v1/adult/status" && request.method() === "GET") {
      await route.fulfill({ json: { confirmed: adultConfirmed } });
      return;
    }
    if (path === "/api/v1/adult/consent" && request.method() === "POST") {
      adultConfirmed = true;
      await route.fulfill({ json: { confirmed: true } });
      return;
    }
    if (path === "/api/v1/memory/status" && request.method() === "GET") {
      await route.fulfill({ json: { allowed: false, paused: false } });
      return;
    }
    if (path === "/api/v1/agent/profile" && request.method() === "GET") {
      await route.fulfill({ json: profile });
      return;
    }
    if (path === "/api/v1/relationship/state" && request.method() === "GET") {
      await route.fulfill({ json: { mood: "平静", trust: 50, affection: 50, irritation: 0, conflict_count: 0, last_trigger: "" } });
      return;
    }
    if (path === "/api/v1/sessions" && request.method() === "POST") {
      sessionCreated = true;
      await route.fulfill({ json: { id: "session-1", title: "新的对话", mode: "girlfriend", updated_at: "2026-10-10T00:00:00Z" } });
      return;
    }
    if (path === "/api/v1/sessions/session-1/messages" && request.method() === "POST") {
      expect(sessionCreated).toBe(true);
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "event: skill_started\ndata: {\"skill_id\":\"girlfriend-core\"}\n\nevent: token\ndata: {\"text\":\"我在听。\"}\n\nevent: done\ndata: {\"message_id\":\"message-1\"}\n\n",
      });
      return;
    }
    if (path === "/api/v1/speech/synthesize" && request.method() === "POST") {
      ttsRequested = true;
      await route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.from("RIFFmock-wav") });
      return;
    }
    if (path === "/api/v1/sessions" && request.method() === "GET") {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === "/api/v1/sessions/session-1" && request.method() === "GET") {
      await route.fulfill({ json: { id: "session-1", title: "新的对话", mode: "girlfriend", updated_at: "2026-10-10T00:00:00Z", messages: [] } });
      return;
    }
    await route.fulfill({ json: [] });
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "新建对话" })).toBeVisible();
  await page.getByRole("button", { name: "新建对话" }).click();
  await expect(page.getByRole("heading", { name: "进入 AI 女友模式" })).toBeVisible();
  await page.getByRole("button", { name: "我已年满 18 周岁" }).click();
  await page.getByRole("button", { name: "新建对话" }).click();
  await expect(page.getByPlaceholder("写下你想说的话...")).toBeVisible();
  await page.getByPlaceholder("写下你想说的话...").fill("今天有点累");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("我在听。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "播放语音" })).toBeVisible();
  await page.getByRole("button", { name: "播放语音" }).click();
  await expect.poll(() => ttsRequested).toBe(true);
  await expect(page.locator("body")).not.toContainText("页面遇到了一点问题");
});
