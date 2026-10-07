import * as http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db";
import { ApiError } from "./errors";
import * as svc from "./service";

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("VALIDATION", "请求体必须是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

export function createServer(db: DatabaseSync): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 500);
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
      const id = parts[1] !== undefined ? Number(parts[1]) : NaN;

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/ingredients") {
        return send(res, 201, svc.createIngredient(db, (await readBody(req)) as any));
      }
      if (method === "GET" && url.pathname === "/ingredients") {
        return send(res, 200, svc.listIngredients(db, limit, offset));
      }
      if (method === "GET" && parts[0] === "ingredients" && Number.isInteger(id)) {
        return send(res, 200, svc.getIngredient(db, id));
      }
      if (method === "POST" && url.pathname === "/mixtures") {
        return send(res, 201, svc.createMixture(db, (await readBody(req)) as any));
      }
      if (method === "GET" && url.pathname === "/mixtures") {
        return send(res, 200, svc.listMixtures(db, limit, offset));
      }
      if (method === "GET" && parts[0] === "mixtures" && Number.isInteger(id)) {
        return send(res, 200, svc.getMixture(db, id));
      }
      if (method === "POST" && url.pathname === "/recipes") {
        return send(res, 201, svc.createRecipe(db, (await readBody(req)) as any));
      }
      if (method === "GET" && parts[0] === "recipes" && Number.isInteger(id)) {
        return send(res, 200, svc.getRecipe(db, id));
      }
      if (method === "POST" && url.pathname === "/reports") {
        return send(res, 201, svc.createReport(db, (await readBody(req)) as any));
      }
      if (method === "GET" && url.pathname === "/reports") {
        return send(res, 200, svc.listReports(db, limit, offset));
      }
      if (method === "GET" && parts[0] === "reports" && Number.isInteger(id) && parts[2] === "leaves") {
        return send(res, 200, svc.getReportLeaves(db, id, limit, offset));
      }
      if (method === "GET" && parts[0] === "reports" && Number.isInteger(id) && parts[2] === "verify") {
        return send(res, 200, svc.verifyConservation(db, id));
      }
      if (method === "GET" && parts[0] === "reports" && Number.isInteger(id) && parts[2] === "recompute") {
        return send(res, 200, svc.recomputeReport(db, id));
      }
      if (method === "GET" && parts[0] === "reports" && Number.isInteger(id) && parts[2] === "export") {
        return send(res, 200, svc.getReport(db, id));
      }
      if (method === "GET" && parts[0] === "reports" && Number.isInteger(id)) {
        return send(res, 200, svc.getReport(db, id));
      }
      throw new ApiError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, e.toJSON());
      send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

// 默认端口 0：由操作系统选择空闲端口
export function startServer(port = 0, dbFile?: string): Promise<{ server: http.Server; port: number }> {
  const db = openDb(dbFile);
  const server = createServer(db);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actual });
    });
  });
}

if (require.main === module) {
  const port = process.env.PORT ? Number(process.env.PORT) : 0;
  startServer(port).then(({ port: p }) => {
    console.log(`烘焙核算 API 已启动: http://localhost:${p}`);
  });
}
