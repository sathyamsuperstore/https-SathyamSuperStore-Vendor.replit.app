import { Router, type IRouter } from "express";
import healthRouter from "./health";
import driveRouter from "./drive";
import pixianRouter from "./pixian";
import authRouter from "./auth";
import pricetagRouter from "./pricetag";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(driveRouter);
router.use(pixianRouter);
router.use(pricetagRouter);

export default router;
