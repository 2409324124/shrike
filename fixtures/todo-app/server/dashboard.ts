import type { Request, Response } from "express";
import { setTimeout as sleep } from "node:timers/promises";
import { countActiveUsers, countOpenTodos } from "./db.ts";

async function fetchStats() {
  await sleep(300);
  return { openTodos: countOpenTodos() };
}

async function fetchActivity() {
  await sleep(300);
  return { activeUsers: countActiveUsers() };
}

export async function getDashboard(req: Request, res: Response) {
  const stats = await fetchStats();
  const activity = await fetchActivity();
  res.json({ ...stats, ...activity });
}
