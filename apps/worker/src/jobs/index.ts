export interface SendConfirmationPayload {
  subscriberId: string;
  email: string;
}

export interface SendWelcomePayload {
  subscriberId: string;
  email: string;
}

export interface ProcessCampaignPayload {
  campaignId: string;
}

export type JobPayloadMap = {
  send_confirmation: SendConfirmationPayload;
  send_welcome: SendWelcomePayload;
  process_campaign: ProcessCampaignPayload;
};
