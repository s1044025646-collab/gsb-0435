import * as http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "./fraction";
import * as svc from "./service";

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("INVALID_INPUT", "请求体不是合法 JSON");
  }
}

export function createServer(db: DatabaseSync): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      const method = req.method ?? "GET";
      const body: any = method === "POST" ? await readBody(req) : {};

      if (method === "GET" && p === "/health") return send(200, { ok: true });
      if (method === "POST" && p === "/ingredients") return send(201, svc.createIngredient(db, body.name, body.category));
      if (method === "GET" && p === "/ingredients") {
        return send(200, db.prepare("SELECT * FROM ingredients ORDER BY id").all());
      }
      if (method === "POST" && p === "/mixtures") return send(201, svc.createMixture(db, body.name, body.items));
      if (method === "POST" && p === "/recipes") return send(201, svc.createRecipe(db, body.name, body.items, body.requestId));
      if (method === "POST" && p === "/reports") {
        return send(201, svc.generateReport(db, Number(body.recipeId), body.targetTotalMass, body.requestId));
      }
      const reportMatch = p.match(/^\/reports\/(\d+)$/);
      if (method === "GET" && reportMatch) return send(200, svc.getReport(db, Number(reportMatch[1])));
      if (method === "GET" && p === "/reports") {
        return send(200, svc.listReports(db, Number(url.searchParams.get("page") ?? 1), Number(url.searchParams.get("pageSize") ?? 20)));
      }
      const expandMatch = p.match(/^\/recipes\/(\d+)\/expand$/);
      if (method === "GET" && expandMatch) {
        const payload = svc.generateReport(db, Number(expandMatch[1]), url.searchParams.get("targetTotalMass") ?? undefined);
        return send(200, payload);
      }
      const consMatch = p.match(/^\/recipes\/(\d+)\/conservation$/);
      if (method === "GET" && consMatch) {
        return send(200, svc.verifyConservation(db, Number(consMatch[1]), url.searchParams.get("targetTotalMass") ?? undefined));
      }
      return send(404, { error: { code: "NOT_FOUND", message: `未知路由: ${method} ${p}` } });
    } catch (e) {
      if (e instanceof ApiError) return send(400, { error: { code: e.code, message: e.message, details: e.details } });
      return send(500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

export function startServer(db: DatabaseSync, port: number): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer(db);
    server.on("error", reject);
    // port=0 让操作系统分配空闲端口
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : port, server });
    });
  });
}
