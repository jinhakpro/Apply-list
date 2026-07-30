// Val Town cron val — 진학프로 즉시지원 공고 스크래퍼
// 15분마다 실행되어 신규 즉시지원 공고를 구글 시트에 추가합니다.
//
// 필요한 Val Town 환경변수:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  - 서비스 계정 client_email
//   GOOGLE_PRIVATE_KEY            - 서비스 계정 private_key (PEM, \n 포함 그대로)
//   GOOGLE_SHEET_ID               - 스프레드시트 ID
//     (https://docs.google.com/spreadsheets/d/<이 부분>/edit)

const JINHAKPRO_API =
  "https://www.jinhakpro.com/api/applicant/recruit/sub-list?isOnlyOnlineApply=true&bookmarkSortType=1&majorCategoryCode=&recruitTypeCode=&sortType=1";

const SHEET_NAME = "즉시지원 리스트";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

interface RecruitItem {
  recruitIdx: number;
  organName: string;
  recruitTitle: string;
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = "";
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const clean = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(clientEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encoder = new TextEncoder();
  const signingInput =
    base64url(encoder.encode(JSON.stringify(header))) +
    "." +
    base64url(encoder.encode(JSON.stringify(claim)));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem.replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(signingInput),
  );

  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    throw new Error(`Google 토큰 발급 실패: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token as string;
}

async function fetchImmediateApplyList(): Promise<RecruitItem[]> {
  const res = await fetch(JINHAKPRO_API, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) {
    throw new Error(`진학프로 API 호출 실패: ${res.status}`);
  }
  return await res.json();
}

async function getExistingIds(sheetId: string, accessToken: string): Promise<Set<string>> {
  const range = encodeURIComponent(`${SHEET_NAME}!A2:A`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`시트 조회 실패: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const rows: string[][] = data.values ?? [];
  return new Set(rows.map((r) => String(r[0]).trim()).filter(Boolean));
}

async function appendRows(sheetId: string, accessToken: string, rows: (string | number)[][]) {
  if (rows.length === 0) return;
  const range = encodeURIComponent(`${SHEET_NAME}!A:D`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: rows }),
    },
  );
  if (!res.ok) {
    throw new Error(`시트 추가 실패: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const clientEmail = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = Deno.env.get("GOOGLE_PRIVATE_KEY");
  const sheetId = Deno.env.get("GOOGLE_SHEET_ID");

  if (!clientEmail || !privateKey || !sheetId) {
    throw new Error(
      "환경변수 GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_SHEET_ID 를 설정해주세요.",
    );
  }

  const accessToken = await getAccessToken(clientEmail, privateKey);
  const [items, existingIds] = await Promise.all([
    fetchImmediateApplyList(),
    getExistingIds(sheetId, accessToken),
  ]);

  const newRows = items
    .filter((item) => !existingIds.has(String(item.recruitIdx)))
    .map((item) => [
      item.recruitIdx,
      item.organName,
      item.recruitTitle,
      `https://www.jinhakpro.com/recruit/${item.recruitIdx}`,
    ]);

  await appendRows(sheetId, accessToken, newRows);

  console.log(
    `조회 ${items.length}건 중 신규 ${newRows.length}건 추가 완료 (${new Date().toISOString()})`,
  );
}

export default main;
