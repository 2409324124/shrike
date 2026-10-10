// Uses each database driver for real, one route per driver. Responses are deterministic, so a run with and without
// node-agent can be compared byte for byte. URLs come from the test (real containers, plus a fake HTTP server).
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const env = process.env;
const strip = (rows) => rows.map(({ _id, __v, ...r }) => r);

const routes = {
  async "/pg"() {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: env.PG_URL });
    try {
      await pool.query("DROP TABLE IF EXISTS notes; CREATE TABLE notes (id serial PRIMARY KEY, title text NOT NULL, api_token text)");
      const ins = await pool.query("INSERT INTO notes (title, api_token) VALUES ($1, $2) RETURNING id, title", ["first", "tok-123"]);
      await pool.query("UPDATE notes SET title = $1 WHERE id = $2", ["renamed", ins.rows[0].id]);
      const client = await pool.connect();
      const viaCallback = await new Promise((res, rej) => client.query("SELECT title FROM notes WHERE id = $1", [1], (e, r) => (e ? rej(e) : res(r.rows))));
      client.release();
      const bad = await pool.query("INSERT INTO notes (title) VALUES (NULL)").then(() => "no error", (e) => e.code);
      await pool.query("DELETE FROM notes WHERE id = $1", [1]);
      return { ins: ins.rows, viaCallback, bad };
    } finally {
      await pool.end();
    }
  },
  async "/postgresjs"() {
    const postgres = (await import("postgres")).default;
    const sql = postgres(env.PG_URL, { onnotice: () => {} });
    try {
      await sql`DROP TABLE IF EXISTS pjs`;
      await sql`CREATE TABLE pjs (id serial PRIMARY KEY, name text)`;
      const rows = await sql`INSERT INTO pjs (name) VALUES (${"ada"}) RETURNING *`;
      const found = await sql`SELECT name FROM pjs WHERE id = ${rows[0].id}`;
      return { rows: [...rows], found: [...found] };
    } finally {
      await sql.end();
    }
  },
  async "/drizzle"() {
    const pg = (await import("pg")).default;
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { pgTable, serial, text } = await import("drizzle-orm/pg-core");
    const { eq } = await import("drizzle-orm");
    const todo = pgTable("todo", { id: serial("id").primaryKey(), text: text("text").notNull() });
    const pool = new pg.Pool({ connectionString: env.PG_URL });
    try {
      await pool.query("DROP TABLE IF EXISTS todo; CREATE TABLE todo (id serial PRIMARY KEY, text text NOT NULL)");
      const db = drizzle(pool);
      const made = await db.insert(todo).values({ text: "buy milk" }).returning();
      const all = await db.select().from(todo).where(eq(todo.id, made[0].id));
      return { made, all };
    } finally {
      await pool.end();
    }
  },
  async "/mysql"() {
    const mysql = await import("mysql2/promise");
    const pool = mysql.createPool(env.MYSQL_URL);
    try {
      await pool.query("DROP TABLE IF EXISTS users");
      await pool.query("CREATE TABLE users (id int AUTO_INCREMENT PRIMARY KEY, firstName varchar(50), password varchar(50))");
      const [ins] = await pool.execute("INSERT INTO users (firstName, password) VALUES (?, ?)", ["Ada", "hunter2"]);
      await pool.query("UPDATE users SET firstName = ? WHERE id = ?", ["Grace", ins.insertId]);
      const [rows] = await pool.query("SELECT id, firstName FROM users");
      return { insertId: ins.insertId, rows };
    } finally {
      await pool.end();
    }
  },
  async "/sequelize"() {
    const { Sequelize, DataTypes } = require("sequelize");
    const s = new Sequelize(env.MYSQL_URL, { logging: false });
    try {
      const Instrument = s.define("instrument", { type: DataTypes.STRING }, { timestamps: false });
      await Instrument.sync({ force: true });
      const made = await Instrument.create({ type: "violin" });
      const all = await Instrument.findAll({ raw: true });
      return { made: made.get({ plain: true }), all };
    } finally {
      await s.close();
    }
  },
  async "/mongo"() {
    const { MongoClient } = await import("mongodb");
    const c = new MongoClient(env.MONGO_URL);
    try {
      const users = c.db("shrike").collection("users");
      await users.deleteMany({});
      await users.insertOne({ email: "ada@example.com", password: "hunter2" });
      await users.updateOne({ email: "ada@example.com" }, { $set: { name: "Ada" } });
      const found = await users.find({ email: "ada@example.com" }).toArray();
      return { found: strip(found), count: await users.countDocuments() };
    } finally {
      await c.close();
    }
  },
  async "/mongoose"() {
    const mongoose = require("mongoose");
    const conn = await mongoose.createConnection(env.MONGO_URL.replace(/\/[^/?]*(\?|$)/, "/shrike$1")).asPromise();
    try {
      const Token = conn.model("Token", new mongoose.Schema({ token: String, user: String }));
      await Token.deleteMany({});
      await Token.create({ token: "abc", user: "ada" });
      const found = await Token.find({ user: "ada" }).lean();
      return { found: strip(found) };
    } finally {
      await conn.close();
    }
  },
  async "/mongo3"() {
    const { MongoClient } = require("mongodb3");
    const out = {};
    // Unified topology (cmap) and the legacy topology mongoose 5 uses by default.
    for (const [name, useUnifiedTopology] of [["unified", true], ["legacy", false]]) {
      const c = await MongoClient.connect(env.MONGO_URL, { useUnifiedTopology, useNewUrlParser: true });
      try {
        const col = c.db("shrike").collection(name);
        await col.deleteMany({});
        await col.insertOne({ n: 1 });
        out[name] = strip(await col.find({ n: 1 }).toArray());
      } finally {
        await c.close();
      }
    }
    return out;
  },
  async "/redis"() {
    const { createClient } = await import("redis");
    const c = await createClient({ url: env.REDIS_URL }).connect();
    try {
      await c.del("todos:1");
      await c.set("todos:1", "milk");
      const got = await c.get("todos:1");
      const miss = await c.get("todos:nope");
      const json = await c.json.set("todos:2", "$", { name: "x" }).then(() => "ok", (e) => String(e.message).split(" ")[0]);
      return { got, miss, json };
    } finally {
      await c.quit();
    }
  },
  async "/redis4"() {
    const { createClient } = require("redis4");
    const c = createClient({ url: env.REDIS_URL });
    await c.connect();
    try {
      await c.set("v4:key", "1");
      return { got: await c.get("v4:key") };
    } finally {
      await c.quit();
    }
  },
  async "/sqlite"() {
    const Database = require("better-sqlite3");
    const db = new Database(path.join(env.SQLITE_DIR, "bs3.db"));
    db.exec("DROP TABLE IF EXISTS items; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    const r = db.prepare("INSERT INTO items (name) VALUES (?)").run("pen");
    db.prepare("UPDATE items SET name = ? WHERE id = ?").run("pencil", r.lastInsertRowid);
    const rows = db.prepare("SELECT * FROM items").all();
    db.close();
    return { rows };
  },
  async "/libsql"() {
    const { createClient } = await import("@libsql/client");
    const c = createClient({ url: `file:${path.join(env.SQLITE_DIR, "libsql.db")}` });
    await c.execute("DROP TABLE IF EXISTS tags");
    await c.execute("CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)");
    await c.execute({ sql: "INSERT INTO tags (label) VALUES (?)", args: ["red"] });
    const rs = await c.execute("SELECT id, label FROM tags");
    c.close();
    return { rows: rs.rows.map((r) => ({ id: Number(r.id), label: r.label })) };
  },
  async "/prisma"() {
    const { PrismaClient } = require("./prisma/generated");
    const p = new PrismaClient();
    try {
      await p.note.deleteMany({});
      const made = await p.note.create({ data: { title: "hello", body: "world" } });
      const updated = await p.note.update({ where: { id: made.id }, data: { title: "bye" } });
      const all = await p.note.findMany();
      await Promise.all([p.note.count(), p.tag.findMany()]);
      await p.tag.upsert({ where: { id: 7 }, create: { label: "x" }, update: { label: "y" } });
      return { made: { title: made.title }, updated: { title: updated.title }, n: all.length };
    } finally {
      await p.$disconnect();
    }
  },
  async "/dynamo"() {
    const { DynamoDBClient, PutItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
    const c = new DynamoDBClient({ endpoint: env.FAKE_URL, region: "local", credentials: { accessKeyId: "x", secretAccessKey: "y" } });
    await c.send(new PutItemCommand({ TableName: "orders", Item: { id: { S: "o1" }, total: { N: "42" } } }));
    const got = await c.send(new GetItemCommand({ TableName: "orders", Key: { id: { S: "o1" } } }));
    await DynamoDBDocumentClient.from(c).send(new PutCommand({ TableName: "orders", Item: { id: "o2", total: 7 } }));
    return { got: got.Item };
  },
  async "/supabase"() {
    const { createClient } = await import("@supabase/supabase-js");
    const s = createClient(env.FAKE_URL, "anon-key-123", { auth: { persistSession: false } });
    const { data } = await s.from("notes").select("id, title").eq("id", 1);
    const ins = await s.from("notes").insert({ title: "new" }).select();
    return { data, ins: ins.data };
  },
  async "/upstash"() {
    const { Redis } = await import("@upstash/redis");
    const r = new Redis({ url: env.FAKE_URL + "/upstash", token: "up-token" });
    await r.set("session:abc", "1");
    return { got: await r.get("session:abc") };
  },
  async "/neon"() {
    const { neon, neonConfig } = await import("@neondatabase/serverless");
    neonConfig.fetchEndpoint = () => env.FAKE_URL + "/sql";
    const sql = neon("postgresql://neon_user:neon-secret-pw@ep-x.neon.tech/neondb");
    return { rows: await sql`SELECT ${1}::int AS one` };
  },
};

http
  .createServer(async (req, res) => {
    const route = routes[req.url];
    if (!route) return void res.writeHead(404).end();
    try {
      const out = await route();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(e?.stack ?? e));
    }
  })
  .listen(Number(env.PORT ?? 0), "127.0.0.1", function () {
    console.log(`listening ${this.address().port}`);
  });
