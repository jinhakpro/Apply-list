// Val Town cron val — 진학프로 즉시지원 공고 스크래퍼
// 15분마다 실행되어 신규 즉시지원 공고를 아래 4개 시트에 기록합니다.
//   1) 즉시지원 리스트   : 공고ID, 기관명, 공고명, 공고 링크, 이메일 발송여부(미발송)
//   2) 광고배너 등록     : 공고ID, 제목, 내용, 로고 이미지 파일, 배경색, 링크, 배너운영기간
//   3) 오카방 메시지     : 공고ID, [기관명]공고명, 링크
//   4) 소셜발행          : idx, org_name, recr_title, major_1~8, major_etc_txt, degree, apply_end, region, dday, facebookLink
//
// 필요한 Val Town 환경변수:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  - 서비스 계정 client_email
//   GOOGLE_PRIVATE_KEY            - 서비스 계정 private_key (PEM, \n 포함 그대로)
//   GOOGLE_SHEET_ID               - 스프레드시트 ID
//     (https://docs.google.com/spreadsheets/d/<이 부분>/edit)

const JINHAKPRO_LIST_API =
  "https://www.jinhakpro.com/api/applicant/recruit/sub-list?isOnlyOnlineApply=true&bookmarkSortType=1&majorCategoryCode=&recruitTypeCode=&sortType=1";
const JINHAKPRO_DETAIL_API = (recruitIdx: number | string) =>
  `https://www.jinhakpro.com/api/applicant/recruit/recruit-detail/${recruitIdx}`;

const SHEET_LIST = "즉시지원 리스트";
const SHEET_AD = "광고배너 등록";
const SHEET_CHAT = "오카방 메시지";
const SHEET_SOCIAL = "소셜발행";
const SHEET_COLOR_DB = "배너 배경색 DB";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const EDU_LEVEL_MAP: Record<string, string> = {
  H: "고졸",
  J: "전문학사",
  B: "학사",
  M: "석사",
  D: "박사",
};

const SOCIAL_HEADERS = [
  "idx",
  "org_name",
  "recr_title",
  "major_1",
  "major_2",
  "major_3",
  "major_4",
  "major_5",
  "major_6",
  "major_7",
  "major_8",
  "major_etc_txt",
  "degree",
  "apply_end",
  "region",
  "dday",
  "facebookLink",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface RecruitListItem {
  recruitIdx: number;
  organName: string;
  recruitTitle: string;
}

/* ========== base64url / RSA JWT ========== */

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

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
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

/* ========== 진학프로 API ========== */

async function fetchImmediateApplyList(): Promise<RecruitListItem[]> {
  const res = await fetch(JINHAKPRO_LIST_API, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`진학프로 목록 API 호출 실패: ${res.status}`);
  return await res.json();
}

async function fetchRecruitDetail(recruitIdx: number | string): Promise<any> {
  const res = await fetch(JINHAKPRO_DETAIL_API(recruitIdx), { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`진학프로 상세 API 호출 실패 (${recruitIdx}): ${res.status}`);
  return await res.json();
}

/* ========== 구글 시트 헬퍼 ========== */

async function getSheetValues(
  sheetId: string,
  accessToken: string,
  range: string,
): Promise<string[][]> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`시트 조회 실패 (${range}): ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.values ?? [];
}

async function appendToSheet(
  sheetId: string,
  accessToken: string,
  sheetName: string,
  rows: (string | number)[][],
) {
  if (rows.length === 0) return;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    },
  );
  if (!res.ok) throw new Error(`시트 추가 실패 (${sheetName}): ${res.status} ${await res.text()}`);
}

async function updateSheetRange(
  sheetId: string,
  accessToken: string,
  range: string,
  rows: (string | number)[][],
) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: rows }),
    },
  );
  if (!res.ok) throw new Error(`시트 갱신 실패 (${range}): ${res.status} ${await res.text()}`);
}

async function ensureSocialHeaders(sheetId: string, accessToken: string) {
  const existing = await getSheetValues(sheetId, accessToken, `${SHEET_SOCIAL}!A1:Q1`);
  if (existing.length > 0 && existing[0].some((v) => String(v).trim())) return;
  await updateSheetRange(sheetId, accessToken, `${SHEET_SOCIAL}!A1:Q1`, [SOCIAL_HEADERS]);
}

/* ========== 가공 헬퍼 (기존 crawl.gs 로직 포팅) ========== */

function stripOrgFromTitle(title: string, org: string): string {
  const t = String(title || "").trim();
  if (!org) return t;
  const escaped = org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = t;
  out = out.replace(new RegExp(`^\\s*\\[\\s*${escaped}\\s*\\]\\s*[-–—·:]*\\s*`, "i"), "");
  out = out.replace(new RegExp(`^\\s*${escaped}\\s*[-–—·:]*\\s*`, "i"), "");
  out = out.replace(new RegExp(`\\s+${escaped}\\s+`, "ig"), " ");
  return out.replace(/\s{2,}/g, " ").trim();
}

function toDotDate(iso: string): string {
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : String(iso);
}

function toDotDateDisplay(iso: string): string {
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}. ${m[2]}. ${m[3]}` : String(iso);
}

function buildDdayText(applyEndISO: string): string {
  if (!applyEndISO) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const deadline = new Date(applyEndISO);
  deadline.setHours(0, 0, 0, 0);
  const diff = Math.round((deadline.getTime() - today.getTime()) / 86400000);
  return diff > 0 ? `마감 D-${diff}` : diff === 0 ? "마감일 D-day" : "마감";
}

/* ========== 메인 ========== */

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

  const [items, existingIdRows, colorDbRows] = await Promise.all([
    fetchImmediateApplyList(),
    getSheetValues(sheetId, accessToken, `${SHEET_LIST}!A2:A`),
    getSheetValues(sheetId, accessToken, `${SHEET_COLOR_DB}!A2:B`),
  ]);

  const existingIds = new Set(existingIdRows.map((r) => String(r[0]).trim()).filter(Boolean));
  const colorMap = new Map<string, string>();
  for (const row of colorDbRows) {
    if (row[0]) colorMap.set(String(row[0]).trim(), String(row[1] ?? "#000000"));
  }

  await ensureSocialHeaders(sheetId, accessToken);

  const newItems = items.filter((item) => !existingIds.has(String(item.recruitIdx)));

  let successCount = 0;

  for (const item of newItems) {
    const recruitIdx = String(item.recruitIdx);
    const 공고링크 = `https://www.jinhakpro.com/recruit/${recruitIdx}`;

    let detail: any = null;
    let applyEndISO = "";
    try {
      detail = await fetchRecruitDetail(recruitIdx);
      applyEndISO = String(detail?.recruitDetail?.recruitData?.apply_end_date || "").trim();
    } catch (err) {
      console.error(
        `상세 조회 실패 (공고ID: ${recruitIdx}):`,
        err instanceof Error ? err.message : err,
      );
    }

    // 1) 즉시지원 리스트 (상세 API 실패해도 최소한 이 행은 남긴다)
    await appendToSheet(sheetId, accessToken, SHEET_LIST, [
      [recruitIdx, item.organName, item.recruitTitle, 공고링크, "미발송", applyEndISO, "미발송"],
    ]);

    if (!detail?.recruitDetail) continue;

    try {
      const rd = detail.recruitDetail;

      const rData = rd.recruitData || {};
      const wc = rData.work_condition || {};

      const 기관명 = String(rd.organName || "").trim();
      const 원본공고명 = String(rd.recruitTitle || "").trim();
      const 정제공고명 = stripOrgFromTitle(원본공고명, 기관명);

      const majorList = rData.major_data?.major_list || [];
      const majorIrrelevant = rData.major_data?.major_irrelevant;
      const majors: string[] = majorIrrelevant
        ? ["전공 무관"]
        : majorList.map((m: any) => String(m.major_name || "").trim()).filter(Boolean);
      const majorFields = Array.from({ length: 8 }, (_, i) => majors[i] || "");
      const majorEtc = majors.length > 8 ? `외 ${majors.length - 8}개` : "";

      const eduLabel = EDU_LEVEL_MAP[wc.highest_education_level_code] || "";
      const degree = eduLabel
        ? wc.is_prospective_graduate
          ? `${eduLabel} 이상, 예비졸업자 가능`
          : `${eduLabel} 이상`
        : "";

      const applyStartISO = String(rData.apply_start_date || "").trim();
      const 배너운영기간Text = applyStartISO && applyEndISO
        ? `${toDotDate(applyStartISO)} ~ ${toDotDate(applyEndISO)}`
        : "";

      const ddayText = buildDdayText(applyEndISO);

      const region = [...new Set(
        (rd.regionData || []).map((r: any) => String(r.region || "").trim()).filter(Boolean),
      )].join(", ");

      const 로고URL = rd.logoFileName
        ? `https://image.jinhakapply.com/trecruit/logo/${rd.logoFileName}${rd.logoFileExt || ""}`
        : "";

      const 배경색 = colorMap.get(기관명) || "#000000";
      const utm링크 = `${공고링크}?utm_source=kakaotalk&utm_medium=referral&utm_campaign=openchat&utm_content=ojp`;
      const fb링크 = `${공고링크}?utm_source=facebook&utm_medium=referral&utm_campaign=facebook&utm_content=ojp`;

      // 2) 광고배너 등록
      await appendToSheet(sheetId, accessToken, SHEET_AD, [
        [recruitIdx, 정제공고명, 배너운영기간Text, 로고URL, 배경색, 공고링크, 배너운영기간Text],
      ]);

      // 3) 오카방 메시지
      await appendToSheet(sheetId, accessToken, SHEET_CHAT, [
        [recruitIdx, `[${기관명}] ${정제공고명}`, utm링크],
      ]);

      // 4) 소셜발행
      await appendToSheet(sheetId, accessToken, SHEET_SOCIAL, [
        [
          recruitIdx,
          기관명,
          정제공고명,
          ...majorFields,
          majorEtc,
          degree,
          toDotDateDisplay(applyEndISO),
          region,
          ddayText,
          fb링크,
        ],
      ]);

      successCount++;
    } catch (err) {
      console.error(
        `상세 처리 실패 (공고ID: ${recruitIdx}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(
    `조회 ${items.length}건 중 신규 ${newItems.length}건, 상세 처리 성공 ${successCount}건 (${new Date().toISOString()})`,
  );
}

export default main;
