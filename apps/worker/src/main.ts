import * as dotenv from "dotenv";
dotenv.config();

import { claimNextJob, completeJob, failJob } from "@ai-signal/queue";
import { handleSendConfirmation } from "./handlers/sendConfirmation";
import { handleSendWelcome } from "./handlers/sendWelcome";
import { handleProcessCampaignBatch } from "./handlers/processCampaign";
import { runCampaignScheduler } from "./scheduler/campaignScheduler";

let isRunning = true;
const POLL_INTERVAL_MS = 2000;

async function processNextJob(): Promise<boolean> {
  const job = await claimNextJob();
  if (!job) return false;

  console.log(`[Worker] Claimed job '${job.jobName}' (ID: ${job.id})`);

  try {
    switch (job.jobName) {
      case "send_confirmation":
        await handleSendConfirmation(job.payload as any);
        break;
      case "send_welcome":
        await handleSendWelcome(job.payload as any);
        break;
      case "process_campaign":
        await handleProcessCampaignBatch(job.payload as any);
        break;
      default:
        console.warn(`[Worker] Unknown job name: ${job.jobName}`);
    }

    await completeJob(job.id);
    console.log(`[Worker] Job ${job.id} completed successfully.`);
    return true;
  } catch (err: any) {
    console.error(`[Worker] Job ${job.id} failed:`, err.message);
    await failJob(job.id, err.message || "Unknown error");
    return true;
  }
}

async function workerLoop() {
  console.log("=================================================");
  console.log("⚡ AI Signal Background Worker Initialized");
  console.log(`Mode: Poll interval ${POLL_INTERVAL_MS}ms`);
  console.log("=================================================");

  let lastSchedulerRun = 0;
  const SCHEDULER_INTERVAL_MS = 30000;

  while (isRunning) {
    try {
      // Check scheduler if interval elapsed
      const now = Date.now();
      if (now - lastSchedulerRun >= SCHEDULER_INTERVAL_MS) {
        lastSchedulerRun = now;
        await runCampaignScheduler();
      }

      const hadJob = await processNextJob();
      if (!hadJob) {
        // No pending jobs, wait for interval
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err: any) {
      console.error("[Worker Loop Error]:", err.message);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  console.log("[Worker] Graceful shutdown complete.");
}

// Graceful termination handling
process.on("SIGINT", () => {
  console.log("\n[Worker] Received SIGINT. Shutting down gracefully...");
  isRunning = false;
});

process.on("SIGTERM", () => {
  console.log("\n[Worker] Received SIGTERM. Shutting down gracefully...");
  isRunning = false;
});

workerLoop();
