import { Router, type IRouter } from "express";
import healthRouter from "./health";
import driveRouter from "./drive";
import pixianRouter from "./pixian";

const router: IRouter = Router();

router.use(healthRouter);
router.use(driveRouter);
router.use(pixianRouter);

export default router;
