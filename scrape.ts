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
//   GMAIL_USER                    - 발신 Gmail 주소 (예: jinhakapplyhelp@gmail.com)
//   GMAIL_APP_PASSWORD            - Gmail 앱 비밀번호 (16자리)
//   EMAIL_RECIPIENTS              - (선택) 신규 공고 알림 수신자 이메일, 콤마로 구분. 미설정 시 기본 수신자 사용
//   D3_EMAIL_RECIPIENTS           - (선택) D-3 마감 알림 수신자 이메일, 콤마로 구분. 미설정 시 cgh@jinhakapply.com

import nodemailer from "npm:nodemailer@6.9.14";

const JINHAKPRO_LIST_API =
  "https://www.jinhakpro.com/api/applicant/recruit/sub-list?isOnlyOnlineApply=true&bookmarkSortType=1&majorCategoryCode=&recruitTypeCode=&sortType=1";
const JINHAKPRO_DETAIL_API = (recruitIdx: number | string) =>
  `https://www.jinhakpro.com/api/applicant/recruit/recruit-detail/${recruitIdx}`;

const SHEET_LIST = "즉시지원 리스트";
const SHEET_AD = "광고배너 등록";
const SHEET_CHAT = "오카방 메시지";
const SHEET_SOCIAL = "소셜발행";
const SHEET_COLOR_DB = "배너 배경색 DB";
const SHEET_CONTRACT = "광고배너 계약 여부";

const DEFAULT_EMAIL_RECIPIENTS =
  "cgh@jinhakapply.com, magi77@jinhakapply.com, yjkim1014@jinhakapply.com, psj@jinhakapply.com";
const DEFAULT_D3_RECIPIENTS = "cgh@jinhakapply.com";

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

/* ========== 이메일 발송 (기존 email.gs / email_template.html 포팅) ========== */

const EMAIL_TEMPLATE_HTML = `<!DOCTYPE html>
<html>
  <p style="line-height:2;">
  <span style="font-size:30px;"><b>신규 즉시지원 공고 알림</b></span>
</p>
<p style="line-height:2;">
  <span style="font-size:18px;">새로운 즉시지원 공고가 등록되었습니다.야호~ </span>
</p>
<br><br>

<p style="line-height:2;">
  <span style="font-size:24px;"><b>공고 정보</b></span>
</p>

<table class="table table-bordered" style="width:100%; text-align:center;">
  <tbody>
    <tr>
      <td style="background-color:#f9f9f9;">기관명</td>
      <td data-type="즉시지원 리스트_기관명">&nbsp;</td>
    </tr>
    <tr>
      <td style="background-color:#f9f9f9;">공고명</td>
      <td data-type="즉시지원 리스트_공고명">&nbsp;</td>
    </tr>
    <tr>
      <td style="background-color:#f9f9f9;">공고ID</td>
      <td data-type="즉시지원 리스트_공고ID">&nbsp;</td>
    </tr>
    <tr>
      <td style="background-color:#f9f9f9;">링크</td>
      <td data-type="즉시지원 리스트_링크">&nbsp;</td>
    </tr>
  </tbody>
</table>

<br><br>

<p style="line-height:2;">
  <span style="font-size:24px;"><b>1. 오픈카톡방 메시지</b></span>
</p>
<p style="line-height:2;">
  <span style="font-size:18px;">※ 방금 뜬 따끈한 즉시지원 공고 배달드립니다 ※</span>
</p>
<p style="line-height:2;">
  <span style="font-size:18px;">오직 진학프로에서만 지원 가능!</span>
</p>
<p data-type="오카방 메시지_[기관명]공고명" style="line-height:2;">
 </p>
 <!-- 오카방 링크 (별도 p, data-type을 p에 직접 지정) -->
<p data-type="오카방 메시지_링크" style="line-height:2;"><span style="font-size:18px;">&nbsp;</span></p>

<br><br>

<p style="line-height:2;">
  <span style="font-size:24px;"><b>2. 광고 배너 등록</b></span>
</p>
<p data-type="광고배너_계약여부"></p>
<table class="table table-bordered" style="width:100%; text-align:center;">
  <tbody>
    <tr>
      <td style="background-color:#f9f9f9;">제목</td>
      <td data-type="광고배너 등록_제목">&nbsp;</td>
    </tr>
    <tr>
      <td style="background-color:#f9f9f9;">내용</td>
      <td data-type="광고배너 등록_내용">&nbsp;</td>
    </tr>
    <tr>
      <td style="background-color:#f9f9f9;">로고 이미지</td>
      <td data-type="광고배너 등록_로고이미지파일">&nbsp;</td>
    </tr>
    <tr>
      <td style="background-color:#f9f9f9;">배경색</td>
      <td data-type="광고배너 등록_배경색">&nbsp;</td>
    </tr>
    <tr>
      <td style="background-color:#f9f9f9;">이동 링크</td>
      <td data-type="광고배너 등록_이동 링크">&nbsp;</td>
    </tr>
    <tr>
      <td style="background-color:#f9f9f9;">배너 운영 기간</td>
      <td data-type="광고배너 등록_배너운영기간">&nbsp;</td>
    </tr>
  </tbody>
</table>

<br><br>

<p style="line-height:2;">
  <span style="font-size:24px;"><b>3. 소셜 발행</b></span>
  <span style="font-size:15px;"> <a href="https://business.facebook.com/latest/home?business_id=919715559676223&asset_id=514834018372928"> [META 바로가기] </a>
</p>

<!-- [소셜 발행] 블록 교체 -->
<p style="line-height:2;">
  <span style="font-size:15px;">1분 전에 뜬 따끈한 즉시지원 공고 배달드립니다♨️</span> <br> <span> 오직 진학프로에서만 지원 가능! </span>
</p>

<p data-type="소셜발행_기관명_공고명" style="line-height:2;" ><span style="font-size:15px;">&nbsp;</span></p>
<p data-type="소셜발행_facebook링크" style="line-height:2;"><span style="font-size:15px;">&nbsp;</span></p>

<p style="line-height:2;">
  <span style="font-size:15px;">· 모집전공: </span>
  <span data-type="소셜발행_모집전공" style="font-size:15px;">&nbsp;</span><br>
  <span style="font-size:15px;">· 지원자격: </span>
  <span data-type="소셜발행_학력" style="font-size:15px;">&nbsp;</span><br>
  <span style="font-size:15px;">· 접수마감: </span>
  <span data-type="소셜발행_접수마감일" style="font-size:15px;">&nbsp;</span><br>
  <span style="font-size:15px;">· 근무지역: </span>
  <span data-type="소셜발행_지역" style="font-size:15px;">&nbsp;</span>
</p>

<p style="line-height:2;">
  <span style="font-size:15px;">진학프로(@jinhakpro) 팔로우하고 석사·박사를 위한 고급 채용 정보를 받아 보세요.</span>
</p>


<br><br>

<table class="table table-bordered" style="width:100%; text-align:center;">
  <tbody>
    <tr style="background-color:#e8f2fd;">
      <td>캐치 공고등록도 잊지 마세요 ^^</td>
    </tr>
  </tbody>
</table>


</html>
`;

interface EmailData {
  공고ID: string;
  기관명: string;
  공고명: string;
  공고링크: string;
  bannerContract: string;
  오카방제목: string;
  오카방링크: string;
  광고제목: string;
  광고내용: string;
  로고이미지파일: string;
  광고배경색: string;
  광고링크: string;
  배너운영기간: string;
  소셜기관명: string;
  소셜공고명: string;
  facebookLink: string;
  majorsText: string;
  degree: string;
  applyEnd: string;
  region: string;
  dday: string;
  소셜공고ID: string;
}

function buildEmailHtml(d: EmailData): string {
  let html = EMAIL_TEMPLATE_HTML;

  html = html
    .replace(/<td[^>]*data-type="즉시지원 리스트_기관명"[^>]*>[\s\S]*?<\/td>/, `<td>${d.기관명}</td>`)
    .replace(/<td[^>]*data-type="즉시지원 리스트_공고명"[^>]*>[\s\S]*?<\/td>/, `<td>${d.공고명}</td>`)
    .replace(/<td[^>]*data-type="즉시지원 리스트_공고ID"[^>]*>[\s\S]*?<\/td>/, `<td>${d.공고ID}</td>`)
    .replace(
      /<td[^>]*data-type="즉시지원 리스트_링크"[^>]*>[\s\S]*?<\/td>/,
      `<td><a href="${d.공고링크}">${d.공고링크}</a></td>`,
    );

  html = html.replace(
    /<p[^>]*data-type="광고배너_계약여부"[^>]*>[\s\S]*?<\/p>/,
    `<p data-type="광고배너_계약여부" style="line-height:2; font-size:16px;">${d.bannerContract}</p>`,
  );

  html = html
    .replace(
      /<p[^>]*data-type="오카방 메시지_\[기관명\]공고명"[^>]*>[\s\S]*?<\/p>/,
      `<p><span>${d.오카방제목 || `[${d.기관명}] ${d.공고명}`}</span></p>`,
    )
    .replace(
      /<p[^>]*data-type="오카방 메시지_링크"[^>]*>[\s\S]*?<\/p>/,
      `<p><span><a href="${d.오카방링크 || d.공고링크}">${d.오카방링크 || d.공고링크}</a></span></p>`,
    );

  html = html
    .replace(/<td[^>]*data-type="광고배너 등록_제목"[^>]*>[\s\S]*?<\/td>/, `<td>${d.광고제목 || ""}</td>`)
    .replace(/<td[^>]*data-type="광고배너 등록_내용"[^>]*>[\s\S]*?<\/td>/, `<td>${d.광고내용 || ""}</td>`)
    .replace(
      /<td[^>]*data-type="광고배너 등록_로고이미지파일"[^>]*>[\s\S]*?<\/td>/,
      `<td><span style="word-break: break-all;">${d.로고이미지파일 || ""}</span></td>`,
    )
    .replace(/<td[^>]*data-type="광고배너 등록_배경색"[^>]*>[\s\S]*?<\/td>/, `<td>${d.광고배경색 || ""}</td>`)
    .replace(
      /<td[^>]*data-type="광고배너 등록_이동 링크"[^>]*>[\s\S]*?<\/td>/,
      `<td><a href="${d.광고링크 || d.공고링크}">${d.광고링크 || d.공고링크}</a></td>`,
    )
    .replace(
      /<td[^>]*data-type="광고배너 등록_배너운영기간"[^>]*>[\s\S]*?<\/td>/,
      `<td>${d.배너운영기간 || ""}</td>`,
    );

  html = html
    .replace(
      /<p[^>]*data-type="소셜발행_기관명_공고명"[^>]*>[\s\S]*?<\/p>/,
      `<p><span>[${d.소셜기관명}] ${d.소셜공고명}</span></p>`,
    )
    .replace(
      /<p[^>]*data-type="소셜발행_facebook링크"[^>]*>[\s\S]*?<\/p>/,
      `<p><a href="${d.facebookLink}">${d.facebookLink}</a></p>`,
    )
    .replace(
      /<(td|span)[^>]*data-type="소셜발행_모집전공"[^>]*>[\s\S]*?<\/\1>/,
      `<$1>${d.majorsText || ""}</$1>`,
    )
    .replace(/<(td|span)[^>]*data-type="소셜발행_학력"[^>]*>[\s\S]*?<\/\1>/, `<$1>${d.degree || ""}</$1>`)
    .replace(/<(td|span)[^>]*data-type="소셜발행_지역"[^>]*>[\s\S]*?<\/\1>/, `<$1>${d.region || ""}</$1>`)
    .replace(
      /<(td|span)[^>]*data-type="소셜발행_접수마감일"[^>]*>[\s\S]*?<\/\1>/,
      `<$1>${d.applyEnd || ""}</$1>`,
    )
    .replace(/<(td|span)[^>]*data-type="소셜발행_DDAY"[^>]*>[\s\S]*?<\/\1>/, `<$1>${d.dday || ""}</$1>`);

  html = html.replace(
    /<td[^>]*data-type="소셜발행_공고ID"[^>]*>[\s\S]*?<\/td>/,
    `<td>${d.소셜공고ID}</td>`,
  );

  return html;
}

async function sendEmail(gmailUser: string, gmailAppPassword: string, to: string, subject: string, html: string) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailAppPassword },
  });
  await transporter.sendMail({ from: gmailUser, to, subject, html });
}

async function checkAndSendEmails(sheetId: string, accessToken: string) {
  const gmailUser = Deno.env.get("GMAIL_USER");
  const gmailAppPassword = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!gmailUser || !gmailAppPassword) {
    console.log("GMAIL_USER / GMAIL_APP_PASSWORD 미설정 — 이메일 발송 단계를 건너뜁니다.");
    return;
  }
  const recipients = Deno.env.get("EMAIL_RECIPIENTS") || DEFAULT_EMAIL_RECIPIENTS;

  const [listRows, adRows, chatRows, socialRows, contractRows] = await Promise.all([
    getSheetValues(sheetId, accessToken, `${SHEET_LIST}!A2:G`),
    getSheetValues(sheetId, accessToken, `${SHEET_AD}!A2:G`),
    getSheetValues(sheetId, accessToken, `${SHEET_CHAT}!A2:C`),
    getSheetValues(sheetId, accessToken, `${SHEET_SOCIAL}!A2:Q`),
    getSheetValues(sheetId, accessToken, `${SHEET_CONTRACT}!A2:B`),
  ]);

  const byId = (rows: string[][]) => {
    const map = new Map<string, string[]>();
    for (const row of rows) if (row[0]) map.set(String(row[0]).trim(), row);
    return map;
  };
  const adMap = byId(adRows);
  const chatMap = byId(chatRows);
  const socialMap = byId(socialRows);

  const contractMap = new Map<string, string>();
  for (const row of contractRows) if (row[0]) contractMap.set(String(row[0]).trim(), String(row[1] ?? ""));

  let sentCount = 0;

  for (let i = 0; i < listRows.length; i++) {
    const row = listRows[i];
    const 공고ID = String(row[0] || "").trim();
    if (!공고ID) continue;
    const status = String(row[4] || "").trim();
    if (status !== "미발송") continue;

    const 기관명 = String(row[1] || "").trim();
    const 공고명 = String(row[2] || "").trim();
    const 공고링크 = String(row[3] || "").trim();
    if (!기관명 || !공고명 || !공고링크) {
      console.warn(`필수값 부족으로 발송 보류: 공고ID=${공고ID}`);
      continue;
    }

    const rowNumber = i + 2; // A2부터 시작

    try {
      const contractYn = (contractMap.get(기관명) || "").trim();
      const bannerContract = contractYn === "Y" ? "배너 등록O" : "배너 등록X";

      const ad = adMap.get(공고ID) || [];
      const [, 광고제목, 광고내용, 로고이미지파일, 광고배경색, 광고링크, 배너운영기간] = ad;

      const chat = chatMap.get(공고ID) || [];
      const [, 오카방제목, 오카방링크] = chat;

      const social = socialMap.get(공고ID) || [];
      const 소셜기관명 = social[1] || "";
      const 소셜공고명 = social[2] || "";
      const majorsArr = social.slice(3, 11).map((v) => String(v || "").trim()).filter(Boolean);
      const majorEtc = String(social[11] || "").trim();
      const degree = String(social[12] || "").trim();
      const applyEnd = String(social[13] || "").trim();
      const region = String(social[14] || "").trim();
      const dday = String(social[15] || "").trim();
      const facebookLink = String(social[16] || "").trim();
      const majorsText = [...majorsArr, majorEtc].filter(Boolean).join(", ");

      const html = buildEmailHtml({
        공고ID,
        기관명,
        공고명,
        공고링크,
        bannerContract,
        오카방제목: 오카방제목 || "",
        오카방링크: 오카방링크 || "",
        광고제목: 광고제목 || "",
        광고내용: 광고내용 || "",
        로고이미지파일: 로고이미지파일 || "",
        광고배경색: 광고배경색 || "",
        광고링크: 광고링크 || "",
        배너운영기간: 배너운영기간 || "",
        소셜기관명,
        소셜공고명,
        facebookLink,
        majorsText,
        degree,
        applyEnd,
        region,
        dday,
        소셜공고ID: social[0] || 공고ID,
      });

      await sendEmail(gmailUser, gmailAppPassword, recipients, `[즉시지원 알림] ${기관명} ${공고명}`, html);

      await updateSheetRange(sheetId, accessToken, `${SHEET_LIST}!E${rowNumber}`, [["발송완료"]]);
      sentCount++;
    } catch (err) {
      console.error(`이메일 발송 실패 (공고ID: ${공고ID}):`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`이메일 발송 완료: ${sentCount}건`);
}

/* ========== D-3 마감 알림 (기존 "D-3 email.gs" 포팅) ========== */

interface D3Target {
  id: string;
  org: string;
  title: string;
  link: string;
  rowNumber: number;
}

function buildD3Html(targets: D3Target[]): string {
  let html = `
    <div style="font-family: Arial; font-size: 14px;">
      <h2>📢 즉시지원 마감 D-3 알림</h2>
      <p>스펙통계 소셜발행할 타이밍~</p>
      <hr>
  `;

  for (const item of targets) {
    html += `
      <p style="line-height:2;">
        <span style="font-size:18px;"><b>📌 공고 정보</b></span>
      </p>

      <table style="width:100%; border-collapse: collapse;" border="1">
        <tbody>
          <tr>
            <td style="background:#f6f6f6; padding:8px; width:20%;">기관명</td>
            <td style="padding:8px;">${item.org}</td>
          </tr>
          <tr>
            <td style="background:#f6f6f6; padding:8px;">공고명</td>
            <td style="padding:8px;">${item.title}</td>
          </tr>
          <tr>
            <td style="background:#f6f6f6; padding:8px;">링크</td>
            <td style="padding:8px;">
              <a href="${item.link}">
                ${item.link}
              </a>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9f9f9; padding:8px;">MOA 통계 다운로드</td>
            <td style="padding:8px;"><a href="https://moa.jinhakapply.com/Trecruit/ImmediateApply?data=%7B%22searchTitle%22%3Anull,%22page%22%3A0,%22tab%22%3A%22all%22%7D">바로가기</a></td>
          </tr>
          <tr>
            <td style="background-color:#f9f9f9; padding:8px;">구글시트</td>
            <td style="padding:8px;"><a href="https://docs.google.com/spreadsheets/d/1L_oGcvWerbSI6Gu5l8zlmwqWTWW3dK7URlMuB0foKHA/edit?gid=0#gid=0">바로가기</a></td>
          </tr>
        </tbody>
      </table>

      <br><hr><br>
    `;
  }

  html += `</div>`;
  return html;
}

async function sendD3Reminders(sheetId: string, accessToken: string) {
  const gmailUser = Deno.env.get("GMAIL_USER");
  const gmailAppPassword = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!gmailUser || !gmailAppPassword) {
    console.log("GMAIL_USER / GMAIL_APP_PASSWORD 미설정 — D-3 알림 단계를 건너뜁니다.");
    return;
  }
  const recipient = Deno.env.get("D3_EMAIL_RECIPIENTS") || DEFAULT_D3_RECIPIENTS;

  const rows = await getSheetValues(sheetId, accessToken, `${SHEET_LIST}!A2:G`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const targets: D3Target[] = [];

  rows.forEach((row, index) => {
    const [id, org, title, link, , deadlineStr, status] = row;

    if (!deadlineStr || !status) return;
    if (String(status).trim() !== "미발송") return;

    const deadline = new Date(String(deadlineStr));
    if (Number.isNaN(deadline.getTime())) return;
    deadline.setHours(0, 0, 0, 0);

    const sendDate = new Date(deadline);
    sendDate.setDate(sendDate.getDate() - 3);
    sendDate.setHours(0, 0, 0, 0);
    while (sendDate.getDay() === 0 || sendDate.getDay() === 6) {
      sendDate.setDate(sendDate.getDate() - 1);
    }

    if (sendDate.getTime() === today.getTime()) {
      targets.push({
        id: String(id || ""),
        org: String(org || ""),
        title: String(title || ""),
        link: String(link || ""),
        rowNumber: index + 2,
      });
    }
  });

  if (targets.length === 0) {
    console.log("D-3 대상 없음");
    return;
  }

  const html = buildD3Html(targets);
  await sendEmail(gmailUser, gmailAppPassword, recipient, "즉시지원 마감 D-3 자동 알림", html);

  for (const t of targets) {
    await updateSheetRange(sheetId, accessToken, `${SHEET_LIST}!G${t.rowNumber}`, [["발송완료"]]);
  }

  console.log(`D-3 이메일 발송 완료: ${targets.length}건`);
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

  await checkAndSendEmails(sheetId, accessToken);
  await sendD3Reminders(sheetId, accessToken);
}

export default main;
