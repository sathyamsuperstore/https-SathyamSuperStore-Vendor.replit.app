import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// We sit behind exactly one trusted reverse-proxy hop (Replit's
// edge proxy). Trust *only* that single hop when reading
// X-Forwarded-For. Setting `true` would trust all hops and let any
// client forge req.ip via X-Forwarded-For, defeating per-IP rate
// limiting; setting `1` strips one hop from the right and uses the
// IP the trusted proxy actually saw.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Allow base64-encoded images (1024x1024 JPEG/PNG can land near
// a few hundred KB once base64-expanded), so bump the JSON limit.
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

app.use("/api", router);

export default app;
