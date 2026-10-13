import dns from "dns/promises";

async function verifyDomainDns(domain: string = "aisignal.dev") {
  console.log("==========================================================");
  console.log(`🔎 Checking DNS & Deliverability Readiness for: ${domain}`);
  console.log("==========================================================\n");

  let spfFound = false;
  let dmarcFound = false;

  // 1. Check MX Records
  try {
    const mxRecords = await dns.resolveMx(domain);
    console.log("✅ MX Records Found:");
    mxRecords.forEach((mx) => console.log(`   - Priority: ${mx.priority}, Host: ${mx.exchange}`));
  } catch (err: any) {
    console.log("⚠️ MX Records: Not found or domain unconfigured yet.");
  }

  // 2. Check SPF (TXT record starting with v=spf1)
  try {
    const txtRecords = await dns.resolveTxt(domain);
    const flatTxt = txtRecords.map((chunk) => chunk.join(""));
    const spfRecord = flatTxt.find((r) => r.startsWith("v=spf1"));

    if (spfRecord) {
      spfFound = true;
      console.log(`✅ SPF Record Found:\n   "${spfRecord}"`);
    } else {
      console.log("❌ SPF Record Missing! You need a TXT record for SPF.");
    }
  } catch (err: any) {
    console.log("❌ SPF Record Check: Could not resolve TXT records.");
  }

  // 3. Check DMARC (TXT record at _dmarc.<domain>)
  try {
    const dmarcRecords = await dns.resolveTxt(`_dmarc.${domain}`);
    const flatDmarc = dmarcRecords.map((chunk) => chunk.join(""));
    const dmarc = flatDmarc.find((r) => r.startsWith("v=DMARC1"));

    if (dmarc) {
      dmarcFound = true;
      console.log(`✅ DMARC Record Found:\n   "${dmarc}"`);
    } else {
      console.log("❌ DMARC Record Missing! Mailbox providers require DMARC.");
    }
  } catch (err: any) {
    console.log("❌ DMARC Record Missing at _dmarc." + domain);
  }

  console.log("\n----------------------------------------------------------");
  console.log("📋 Required Production DNS Settings Checklist:");
  console.log("----------------------------------------------------------");
  console.log(`
1. SPF Record (TXT @):
   Type:  TXT
   Host:  @ (or ${domain})
   Value: "v=spf1 include:amazonses.com ~all" (or include:resend.com ~all)

2. DKIM Record (CNAME):
   Type:  CNAME
   Host:  resend._domainkey.${domain}
   Value: (Provided by your email provider console)

3. DMARC Policy (TXT _dmarc):
   Type:  TXT
   Host:  _dmarc.${domain}
   Value: "v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${domain}; pct=100"

4. MX Record (Custom Mail-From domain):
   Type:  MX
   Host:  mail.${domain}
   Value: feedback-smtp.us-east-1.amazonses.com (Priority 10)
  `);

  if (!spfFound || !dmarcFound) {
    console.log(`⚠️ Status: Domain ${domain} needs DNS configuration before public broadcast.`);
  } else {
    console.log(`🎉 Status: Domain ${domain} is fully authenticated and ready to send!`);
  }
}

const targetDomain = process.argv[2] || "aisignal.dev";
verifyDomainDns(targetDomain);
