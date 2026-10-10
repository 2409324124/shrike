// Launched by a test script (Playwright passes a debugging port).
export const automated = process.argv.some((a) => a.startsWith("--remote-debugging-port"));
// Test windows show (without taking focus) so the owner can watch runs; SHRIKE_HEADLESS=1 hides any launch: no window, no Dock icon, no notifications.
export const headless = process.env.SHRIKE_HEADLESS === "1";
