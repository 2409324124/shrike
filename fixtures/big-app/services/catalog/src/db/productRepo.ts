import { db } from "./pool.ts";

export interface Product {
  id: number;
  name: string;
  maker: string;
  category: string;
  priceCents: number;
}
export interface Promotion {
  category: string;
  percentOff: number;
}

const COLUMNS = "id, name, maker, category, price_cents AS \"priceCents\"";

export async function listFeatured(): Promise<Product[]> {
  return (await db.query<Product>(`SELECT ${COLUMNS} FROM products WHERE featured ORDER BY id`)).rows;
}

export async function listAll(): Promise<Product[]> {
  return (await db.query<Product>(`SELECT ${COLUMNS} FROM products ORDER BY id`)).rows;
}

export async function findById(id: number): Promise<Product | undefined> {
  return (await db.query<Product>(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id])).rows[0];
}

export async function findByIds(ids: number[]): Promise<Product[]> {
  return (await db.query<Product>(`SELECT ${COLUMNS} FROM products WHERE id = ANY($1::int[]) ORDER BY id`, [ids])).rows;
}

export async function activePromotions(): Promise<Promotion[]> {
  return (await db.query<Promotion>("SELECT category, percent_off AS \"percentOff\" FROM promotions WHERE ends_at > now()")).rows;
}
