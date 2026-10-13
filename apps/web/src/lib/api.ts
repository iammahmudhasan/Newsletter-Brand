export async function subscribeToNewsletter(email: string, source: string = "web_form") {
  const response = await fetch("/api/subscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, source }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Subscription failed");
  }
  return data;
}

export async function createAdminCampaign(payload: {
  title: string;
  subject: string;
  previewText?: string;
  contentHtml: string;
}) {
  const response = await fetch("/api/admin/campaigns", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to create campaign");
  }
  return data;
}
