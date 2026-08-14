/**
 * dsh-gzip — gzip /api responses for the dsh web GUI.
 *
 * Background: the GUI's history pages can be 4–13MB of uncompressed JSON, and
 * the browser's unary RPC has a hard 30s timeout. Over slow links (e.g. an
 * easytier mesh at ~3Mbps) the response exceeds the budget and the GUI shows
 * 「历史加载失败：The user aborted a request.（internal）」. gzip shrinks the
 * largest pages to ~8% and the transfer lands in ~3s.
 *
 * Why a plugin instead of patching node_modules: the npx cache that
 * `dsh-web.service` runs from is wiped on reinstalls. A plugin lives in the
 * profile workspace (`~/.dsh/profiles`), so it survives.
 *
 * Seam: the `/api` route is exclusively registered by dsh-client-connection
 * (duplicate registration throws) and the bridge function is not exported, so
 * this plugin wraps the route handler *at registration time*: `register` is
 * monkey-patched once, and whenever the `/api` prefix route is claimed its
 * handler is replaced by one that wraps `res` (writeHead/write/end shadowed
 * per instance) to stream gzip for compressible responses when the client
 * accepts it. SSE (text/event-stream), zip exports, and already-encoded
 * responses pass through untouched.
 */
import { createGzip } from "node:zlib";

export const name = "dsh-gzip";
export const inject = ["webServer"];

/** Whether an Accept-Encoding header value accepts gzip (q=0 refusals do not). */
function acceptsGzip(value) {
	if (typeof value !== "string") return false;
	for (const part of value.split(",")) {
		const [coding, ...params] = part.trim().split(";").map((item) => item.trim());
		const q = params.find((param) => param.startsWith("q="));
		if (coding.toLowerCase() !== "gzip") continue;
		if (q === void 0) return true;
		const parsed = Number(q.slice(2));
		if (Number.isFinite(parsed) && parsed > 0) return true;
	}
	return false;
}

/** Compressible content types: JSON, JSON-ish, and text (SSE excluded). */
function isCompressible(contentType) {
	const type = String(contentType).split(";", 1)[0].trim().toLowerCase();
	return type.startsWith("application/json") || type.endsWith("+json") || type.startsWith("text/") && type !== "text/event-stream";
}

function joinVary(existing) {
	const value = existing === void 0 ? "" : String(existing);
	return value === "" ? "accept-encoding" : `${value}, accept-encoding`;
}

/**
 * Wrap one ServerResponse so its body is gzip-compressed. Only wraps when the
 * request accepts gzip; otherwise returns `res` untouched. The shadowing is
 * per-instance (prototype untouched), so nothing outside this request sees it.
 * @param res - the node:http ServerResponse owned by the /api route.
 * @param req - the matching IncomingMessage (read for Accept-Encoding).
 */
function wrapResponse(res, req) {
	if (!acceptsGzip(req.headers["accept-encoding"])) return res;

	const originalWriteHead = res.writeHead.bind(res);
	const originalWrite = res.write.bind(res);
	const originalEnd = res.end.bind(res);
	let gzip = null;

	/** Feed one gzip output chunk to the socket, pausing on socket backpressure. */
	function pump() {
		gzip.on("data", (chunk) => {
			if (!originalWrite(chunk)) {
				gzip.pause();
				res.once("drain", () => gzip.resume());
			}
		});
		gzip.on("end", () => originalEnd());
		gzip.on("error", () => {
			/* Upstream compression failure: close the response; the client sees a
			* truncated body and the bridge's close listener aborts the request. */
			res.destroy();
		});
	}

	res.writeHead = function writeHead(statusCode, statusMessage, headers) {
		if (typeof statusMessage === "object" && statusMessage !== null) {
			headers = statusMessage;
			statusMessage = void 0;
		}
		if (gzip === null && !this.headersSent) {
			const contentType = headers?.["content-type"] ?? this.getHeader("content-type");
			const existingEncoding = headers?.["content-encoding"] ?? this.getHeader("content-encoding");
			if (existingEncoding === void 0 && isCompressible(contentType)) {
				gzip = createGzip();
				if (headers && typeof headers === "object" && !Array.isArray(headers)) {
					delete headers["content-length"];
					headers["content-encoding"] = "gzip";
					headers["vary"] = joinVary(headers["vary"]);
				} else {
					this.removeHeader("content-length");
					this.setHeader("content-encoding", "gzip");
					this.setHeader("vary", joinVary(this.getHeader("vary")));
				}
				pump();
			}
		}
		return originalWriteHead.call(this, statusCode, statusMessage, headers);
	};

	res.write = function write(chunk, encoding, callback) {
		if (gzip === null) return originalWrite.call(this, chunk, encoding, callback);
		if (gzip.write(chunk, encoding)) {
			if (typeof callback === "function") callback();
			return true;
		}
		/* gzip's writable buffer is full — surface its drain as a res "drain"
		* so the bridge's backpressure wait (which only listens on res) resumes. */
		const onDrain = () => {
			gzip.off("drain", onDrain);
			this.emit("drain");
		};
		gzip.on("drain", onDrain);
		if (typeof callback === "function") gzip.once("drain", callback);
		return false;
	};

	res.end = function end(chunk, encoding, callback) {
		if (typeof chunk === "function") {
			callback = chunk;
			chunk = void 0;
		}
		if (gzip === null) return originalEnd.call(this, chunk, encoding, callback);
		if (chunk !== void 0 && chunk !== null) gzip.write(chunk, encoding);
		gzip.end();
		/* originalEnd runs from the gzip "end" handler (pump). */
		if (typeof callback === "function") gzip.once("end", callback);
	};

	return res;
}

/**
 * Install the /api compression wrapper. Register is patched once so the wrap
 * applies no matter when dsh-client-connection claims the /api prefix route
 * (loader entry activation is service-availability driven, not row ordered).
 * Returns the disposer restoring the original register.
 */
export function apply(ctx) {
	const webServer = ctx.webServer;
	const originalRegister = webServer.register.bind(webServer);
	webServer.register = function register(route) {
		const disposer = originalRegister(route);
		if (route.kind === "prefix" && route.path === "/api") {
			const original = route.handler;
			route.handler = (req, res) => original(req, wrapResponse(res, req));
		}
		return disposer;
	};
	ctx.logger.info("dsh-gzip: /api gzip compression enabled");
	return () => {
		webServer.register = originalRegister;
	};
}
