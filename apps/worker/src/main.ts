import * as dotenv from "dotenv";
dotenv.config();

import { claimNextJob, completeJob, failJob, reclaimStaleJobs } from "@ai-signal/queue";
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
        await completeJob(job.id);
        console.log(`[Worker] Job ${job.id} completed successfully.`);
        break;

      case "send_welcome":
        await handleSendWelcome(job.payload as any);
        await completeJob(job.id);
        console.log(`[Worker] Job ${job.id} completed successfully.`);
        break;

      case "process_campaign":
        await handleProcessCampaignBatch(job.payload as any);
        await completeJob(job.id);
        console.log(`[Worker] Job ${job.id} completed successfully.`);
        break;

      default:
        console.error(`[Worker Security Alert] Unknown job name '${job.jobName}' for job ID ${job.id}. Marking as failed.`);
        await failJob(job.id, `Unrecognized job handler: ${job.jobName}`);
        break;
    }

    return true;
  } catch (err: any) {
    console.error(`[Worker] Job ${job.id} execution failed:`, err.message);
    try {
      await failJob(job.id, err.message || "Unknown execution failure");
    } catch (failErr: any) {
      console.error(`[Worker] Failed to record failure for job ${job.id}:`, failErr.message);
    }
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

  let lastRecoveryRun = 0;
  const RECOVERY_INTERVAL_MS = 60000; // Run crash recovery every 60s

  while (isRunning) {
    try {
      const now = Date.now();

      // 1. Run stale job crash recovery loop
      if (now - lastRecoveryRun >= RECOVERY_INTERVAL_MS) {
        lastRecoveryRun = now;
        const reclaimed = await reclaimStaleJobs(10);
        if (reclaimed > 0) {
          console.log(`[Worker Crash Recovery] Reclaimed ${reclaimed} stale jobs.`);
        }
      }

      // 2. Check scheduled campaigns
      if (now - lastSchedulerRun >= SCHEDULER_INTERVAL_MS) {
        lastSchedulerRun = now;
        await runCampaignScheduler();
      }

      // 3. Process pending queue jobs
      const hadJob = await processNextJob();
      if (!hadJob) {
        // No pending jobs, sleep poll interval
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
