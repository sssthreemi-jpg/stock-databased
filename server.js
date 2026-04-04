const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// 네이버 로그인 쿠키 저장 파일
const COOKIE_FILE = path.join(__dirname, '.naver_cookie');
function getNaverCookie() {
  try { return fs.readFileSync(COOKIE_FILE, 'utf-8').trim(); } catch { return ''; }
}
function saveNaverCookie(cookie) {
  fs.writeFileSync(COOKIE_FILE, cookie, 'utf-8');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// AI 리포트 캐시 (1시간 TTL)
const aiReportCache = new Map();
const AI_CACHE_TTL = 60 * 60 * 1000;

// Claude API 호출
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { reject(new Error('ANTHROPIC_API_KEY not set')); return; }

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });

    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Claude 응답 파싱 오류')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Claude API 타임아웃')); });
    req.write(body);
    req.end();
  });
}

// 동시 요청 제한 (네이버 차단 방지)
const MAX_CONCURRENT = 15;
let activeRequests = 0;
const requestQueue = [];

function processQueue() {
  while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT) {
    const { targetUrl, resolve, reject, eucKr } = requestQueue.shift();
    activeRequests++;
    const fn = eucKr ? _doRequestEucKr : _doRequest;
    fn(targetUrl)
      .then(resolve)
      .catch(reject)
      .finally(() => { activeRequests--; processQueue(); });
  }
}

function proxyRequest(targetUrl) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ targetUrl, resolve, reject });
    processQueue();
  });
}

function _doRequest(targetUrl) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://m.stock.naver.com/',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// EUC-KR 페이지용: raw Buffer를 받아서 TextDecoder로 디코딩
function _doRequestEucKr(targetUrl) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://finance.naver.com/',
      },
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const decoder = new TextDecoder('euc-kr');
        const data = decoder.decode(buf);
        resolve({ statusCode: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function proxyRequestEucKr(targetUrl) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ targetUrl, resolve, reject, eucKr: true });
    processQueue();
  });
}

// 네이버 쿠키 포함 요청
function _doRequestWithCookie(targetUrl, cookie) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Referer': 'https://finance.naver.com/',
        'Cookie': cookie,
      },
    };
    const req2 = https.request(options, res2 => {
      let data = '';
      res2.on('data', chunk => data += chunk);
      res2.on('end', () => resolve({ statusCode: res2.statusCode, data }));
    });
    req2.on('error', reject);
    req2.setTimeout(10000, () => { req2.destroy(); reject(new Error('Timeout')); });
    req2.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

  // ── 네이버 업종 번호 탐색: GET /api/industry-scan?from=260&to=340

  // ── 업종별 종목 자동 로드: GET /api/industry?sectors=반도체,바이오,... ──
  if (parsedUrl.pathname === '/api/industry') {
    try {
      // 네이버 업종 번호 매핑
      const SECTOR_MAP = {
        '반도체': [278, 282],        // 반도체 + 전자부품(삼성전기 등)
        '2차전지': [272, 306, 283],  // 화학소재 + 전기장비 + 연료전지
        '바이오': [286, 281, 316],   // 생물공학 + 의료기기 + 헬스케어서비스
        '자동차': [273, 270],        // 자동차 + 자동차부품
        '금융': [321, 330, 301],     // 증권 + 생명보험 + 은행
        '에너지': [295, 313, 325],   // 에너지장비 + 석유가스 + 전력
        '조선': [291],               // 조선
        '통신장비': [294, 333, 307], // 통신장비 + 무선통신 + 전자장비
        '건설': [279, 317],          // 건설 + 부동산
        '로봇': [299, 298],          // 기계 + 가전/로봇
        '화장품': [297, 274],        // 생활용품 + 섬유의류
        '우주항공': [284, 305],      // 방산/우주 + 항공
      };

      const mobileBase = 'https://m.stock.naver.com/api';
      const sectors = (parsedUrl.searchParams.get('sectors') || '').split(',').filter(Boolean);
      const result = {};

      for (const sector of sectors) {
        const industryNos = SECTOR_MAP[sector];
        if (!industryNos) continue;
        const codes = [];
        for (const no of industryNos) {
          try {
            const r = await proxyRequest(`${mobileBase}/stocks/industry/${no}?page=1&pageSize=20`);
            const data = JSON.parse(r.data);
            (data.stocks || []).forEach(s => {
              if (s.itemCode && !codes.includes(s.itemCode) && s.itemCode.endsWith('0')) {
                codes.push(s.itemCode);
              }
            });
          } catch (_) {}
        }
        result[sector] = codes.slice(0, 20);
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── 네이버 쿠키 저장: POST /api/cookie ──
  if (parsedUrl.pathname === '/api/cookie' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { cookie } = JSON.parse(body);
        saveNaverCookie(cookie || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── 네이버 쿠키 상태 확인: GET /api/cookie ──
  if (parsedUrl.pathname === '/api/cookie' && req.method === 'GET') {
    const cookie = getNaverCookie();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasCookie: !!cookie, preview: cookie ? cookie.substring(0, 30) + '...' : '' }));
    return;
  }

  // ── 네이버 관심종목 연동: GET /api/favorite ──
  if (parsedUrl.pathname === '/api/favorite') {
    const cookie = getNaverCookie();
    if (!cookie) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no_cookie', groups: [], items: [] }));
      return;
    }
    try {
      // mystock 페이지에서 관심종목 데이터 추출 (EUC-KR)
      const pageResult = await (new Promise((resolve, reject) => {
        const urlObj = new URL('https://finance.naver.com/mystock/itemList.naver');
        const req2 = https.request({
          hostname: urlObj.hostname, port: 443, path: urlObj.pathname,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': cookie,
            'Referer': 'https://finance.naver.com/',
          },
        }, res2 => {
          const chunks = [];
          res2.on('data', c => chunks.push(c));
          res2.on('end', () => resolve({
            statusCode: res2.statusCode,
            headers: res2.headers,
            data: new TextDecoder('euc-kr').decode(Buffer.concat(chunks)),
          }));
        });
        req2.on('error', reject);
        req2.setTimeout(10000, () => { req2.destroy(); reject(new Error('Timeout')); });
        req2.end();
      }));

      // 302 리다이렉트 = 로그인 안 됨
      if (pageResult.statusCode === 302 || !pageResult.data.includes('var group')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'login_failed',
          message: 'NID_AUT 쿠키가 누락되었거나 만료됨. Network 탭에서 Cookie 헤더를 복사해주세요.',
          groups: [], items: []
        }));
        return;
      }

      // "var group = {...};" 에서 JSON 추출
      const groupMatch = pageResult.data.match(/var group = (\{[\s\S]*?\});/);
      if (!groupMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'parse_failed', groups: [], items: [] }));
        return;
      }

      const groupData = JSON.parse(groupMatch[1]);
      const allItems = (groupData.items || []).map(item => ({
        code: item.itemcode || '',
        name: item.itemname || '',
        group: groupData.groupName || '관심종목',
        price: item.nowVal || 0,
        changeRate: item.changeRate || 0,
        changeVal: item.changeVal || 0,
        per: item.per || 0,
        marketCap: item.marketSum || 0,
        volume: item.accQuant || 0,
        risefall: item.risefall || '',
        marketType: item.marketType || '',
      })).filter(i => i.code);

      // 그룹 목록도 가져오기
      const groupListResult = await _doRequestWithCookie(
        'https://finance.naver.com/mystock/api/getGroupList.naver', cookie
      );
      let groups = [];
      try {
        const gl = JSON.parse(groupListResult.data);
        groups = gl.result || [];
      } catch (_) {}

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ groups, items: allItems }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, groups: [], items: [] }));
    }
    return;
  }

  // 리서치 리포트: /api/research (최근전체), ?code=005930, ?name=삼성전자
  if (parsedUrl.pathname === '/api/research') {
    const code = parsedUrl.searchParams.get('code');
    const name = parsedUrl.searchParams.get('name');

    // 파라미터 없으면 최근 전체 리포트 반환
    if (!code && !name) {
      try {
        const result = await proxyRequestEucKr('https://finance.naver.com/research/company_list.naver?&page=1');
        const html = result.data;
        const reports = [];
        const tbl = html.match(/<table[^>]*class="type_1"[^>]*>([\s\S]*?)<\/table>/);
        if (tbl) {
          const rows = tbl[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
          rows.forEach(r => {
            if (!r.includes('company_read')) return;
            const tds = (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
            const titleMatch = r.match(/company_read[^>]*>([^<]*)</);
            const codeMatch = r.match(/code=(\d{6})/);
            const pdfMatch = r.match(/href="(https:\/\/stock\.pstatic\.net[^"]*)"/);
            reports.push({
              stockCode: codeMatch ? codeMatch[1] : '',
              stockName: tds[0] || '',
              title: titleMatch ? titleMatch[1].trim() : '',
              broker: tds[2] || '',
              date: tds[4] || '',
              views: tds[5] || '',
              pdfUrl: pdfMatch ? pdfMatch[1] : '',
            });
          });
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ reports }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    try {
      // 종목명으로 검색 시 먼저 종목코드 찾기 (name→code)
      let searchCode = code || '';
      let searchName = name || '';
      if (!searchCode && searchName) {
        // 네이버 금융 자동완성 API로 종목코드 찾기
        const searchResult = await proxyRequest(
          `https://ac.stock.naver.com/ac?q=${encodeURIComponent(searchName)}&target=stock`
        );
        try {
          const searchData = JSON.parse(searchResult.data);
          const items = searchData.items || [];
          const stockItem = items.find(i => i.category === 'stock');
          if (stockItem) {
            searchCode = stockItem.code || '';
            searchName = stockItem.name || searchName;
          }
        } catch (_) {}
      }

      let reports = [];
      if (searchCode) {
        const researchResult = await proxyRequestEucKr(
          `https://finance.naver.com/research/company_list.naver?searchType=itemCode&itemCode=${searchCode}&page=1`
        );
        const html = researchResult.data;
        const tbl = html.match(/<table[^>]*class="type_1"[^>]*>([\s\S]*?)<\/table>/);
        if (tbl) {
          const rows = tbl[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
          rows.forEach(r => {
            if (!r.includes('company_read')) return;
            const tds = (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []);
            const titleMatch = r.match(/company_read[^>]*>([^<]*)</);
            const pdfMatch = r.match(/href="(https:\/\/stock\.pstatic\.net[^"]*)"/);
            const tdTexts = tds.map(t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
            reports.push({
              title: titleMatch ? titleMatch[1].trim() : '',
              broker: tdTexts[2] || '',
              date: tdTexts[4] || '',
              views: tdTexts[5] || '',
              pdfUrl: pdfMatch ? pdfMatch[1] : '',
              stockName: searchName,
              stockCode: searchCode,
            });
          });
        }
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ code: searchCode, name: searchName, reports }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 목표주가 스크래핑: /api/target?code=005930
  if (parsedUrl.pathname === '/api/target') {
    const code = parsedUrl.searchParams.get('code');
    if (!code || !/^\d{6}$/.test(code)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid code' }));
      return;
    }
    try {
      // 메인 페이지와 리서치 페이지를 동시에 가져오기
      const [result, researchResult] = await Promise.all([
        proxyRequest(`https://finance.naver.com/item/main.naver?code=${code}`),
        proxyRequestEucKr(`https://finance.naver.com/research/company_list.naver?searchType=itemCode&itemCode=${code}&page=1`),
      ]);
      const html = result.data;

      // 투자의견 & 목표주가 파싱
      let opinion = '', targetPrice = 0;
      const opinionBlock = html.match(/투자의견[\s\S]*?목표주가[\s\S]*?<\/td>\s*<\/tr>/);
      if (opinionBlock) {
        const block = opinionBlock[0];
        // 투자의견: "매수", "중립" 등
        const opMatch = block.match(/(매수|중립|보유|매도|비중축소|적극매수)/);
        if (opMatch) opinion = opMatch[1];
        // 목표주가: <em>256,720</em> (두 번째 <em> 태그)
        const ems = [...block.matchAll(/<em>([\d,]+)<\/em>/g)];
        if (ems.length >= 2) targetPrice = parseInt(ems[1][1].replace(/,/g, ''), 10);
        else if (ems.length === 1) targetPrice = parseInt(ems[0][1].replace(/,/g, ''), 10);
      }

      // 최근 리포트 목록 파싱 (research 탭)
      const reports = [];
      const reportPattern = /class="tltle"[^>]*>([^<]+)<[\s\S]*?class="(?:f_up|f_down|f_none)"[^>]*>([^<]*)<[\s\S]*?<em>([\d,]+)<\/em>/g;
      let m;
      while ((m = reportPattern.exec(html)) !== null && reports.length < 3) {
        reports.push({ title: m[1].trim(), opinion: m[2].trim(), target: parseInt(m[3].replace(/,/g, ''), 10) });
      }

      // 리서치 리포트 페이지에서 증권사, 제목, 날짜 파싱
      let broker = '', reportTitle = '', reportDate = '';
      try {
        const researchHtml = researchResult.data;
        const tableMatch = researchHtml.match(/<table[^>]*class="type_1"[^>]*>([\s\S]*?)<\/table>/);
        if (tableMatch) {
          const tableHtml = tableMatch[1];
          const rows = tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
          // stock_item 또는 company_read 링크가 있는 실제 데이터 행 찾기
          const dataRow = rows.find(r => r.includes('company_read') && !r.includes('blank'));
          if (dataRow) {
            // 제목: company_read 링크의 텍스트
            const titleMatch = dataRow.match(/company_read[^>]*>([^<]*)</);
            if (titleMatch) reportTitle = titleMatch[1].trim();
            // td 태그 추출
            const tdPattern = /<td[^>]*>([\s\S]*?)<\/td>/g;
            const tds = [];
            let tdM;
            while ((tdM = tdPattern.exec(dataRow)) !== null) {
              tds.push(tdM[1].replace(/<[^>]*>/g, '').trim());
            }
            // col0=종목명, col1=제목, col2=증권사, col3=PDF, col4=날짜
            if (tds.length >= 3) broker = tds[2];
            if (tds.length >= 5) reportDate = tds[4];
          }
        }
      } catch (_e) {
        // 리서치 파싱 실패해도 기본 데이터는 반환
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ code, opinion, targetPrice, reports, broker, reportTitle, reportDate }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 퀀트 분석 데이터: /api/quant
  if (parsedUrl.pathname === '/api/quant') {
    try {
      const mobileBase = 'https://m.stock.naver.com/api';
      // 오늘 날짜 생성 (YYYYMMDD)
      const today = new Date();
      const bizdate = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
      const [kospiUp, kosdaqUp, volumeResult, investorResult, foreignBuyKospiResult, foreignBuyKosdaqResult] = await Promise.all([
        proxyRequest(`${mobileBase}/stocks/up?market=KOSPI&page=1&pageSize=20`),
        proxyRequest(`${mobileBase}/stocks/up?market=KOSDAQ&page=1&pageSize=20`),
        proxyRequestEucKr('https://finance.naver.com/sise/sise_quant.naver'),
        proxyRequestEucKr(`https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=${bizdate}`),
        proxyRequestEucKr('https://finance.naver.com/sise/sise_trans_style.naver?sosok=0'),
        proxyRequestEucKr('https://finance.naver.com/sise/sise_trans_style.naver?sosok=1'),
      ]);

      // 모바일 API 데이터 파싱
      let kospiUpData = [], kosdaqUpData = [];
      try { kospiUpData = JSON.parse(kospiUp.data); } catch (_) {}
      try { kosdaqUpData = JSON.parse(kosdaqUp.data); } catch (_) {}

      // 거래량 상위 스크래핑 (PC 네이버 금융 sise_quant)
      let volumeRanking = [];
      try {
        const volHtml = volumeResult.data;
        const volTable = volHtml.match(/<table[^>]*class="type_2"[^>]*>([\s\S]*?)<\/table>/);
        if (volTable) {
          const volRows = volTable[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
          volRows.forEach(r => {
            if (volumeRanking.length >= 30) return;
            const codeMatch = r.match(/code=(\d{6})/);
            if (!codeMatch) return;
            const tds = (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
            if (tds.length < 6) return;
            volumeRanking.push({
              itemCode: codeMatch[1],
              stockName: tds[1],
              closePrice: tds[2],
              compareToPreviousClosePrice: tds[3],
              fluctuationsRatio: tds[4].replace('%', ''),
              accumulatedTradingVolume: tds[5],
              accumulatedTradingValue: tds[6] || '',
            });
          });
        }
      } catch (_) {}

      // 투자자별 매매동향 파싱 (EUC-KR) - 최근 3일
      let investorTrend = [];
      try {
        const investorHtml = investorResult.data;
        const tableMatch = investorHtml.match(/<table[^>]*class="type_1"[^>]*>([\s\S]*?)<\/table>/);
        if (tableMatch) {
          const rows = tableMatch[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
          rows.forEach(r => {
            if (investorTrend.length >= 3) return;
            const tds = (r.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || [])
              .map(t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
              .filter(Boolean);
            // 날짜 형식(YY.MM.DD)인 행만
            if (tds.length >= 4 && /^\d{2}\.\d{2}\.\d{2}$/.test(tds[0])) {
              investorTrend.push({
                date: tds[0],
                individual: tds[1] || '',
                foreign: tds[2] || '',
                institution: tds[3] || '',
              });
            }
          });
        }
      } catch (_e) {
        // 투자자 매매동향 파싱 실패해도 나머지 데이터 반환
      }

      // 외국인/기관 순매수 상위 종목 파싱 (sise_trans_style KOSPI+KOSDAQ)
      let foreignBuy = [], institutionBuy = [];
      function parseTransStyle(html) {
        const result = { foreign: [], institution: [] };
        try {
          const tables = html.match(/<table[^>]*class="type_r1"[^>]*>[\s\S]*?<\/table>/g) || [];
          tables.forEach(tbl => {
            const caption = tbl.match(/<caption>([^<]*)<\/caption>/);
            const capText = caption ? caption[1] : '';
            const rows = tbl.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
            rows.forEach(r => {
              const codeMatch = r.match(/code=(\d{6})/);
              if (!codeMatch) return;
              const tds = (r.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [])
                .map(t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
              const item = { code: codeMatch[1], name: tds[1] || '', price: tds[2] || '' };
              if (capText.includes('외국인')) result.foreign.push(item);
              else if (capText.includes('기관')) result.institution.push(item);
            });
          });
        } catch (_) {}
        return result;
      }
      const kospiDeal = parseTransStyle(foreignBuyKospiResult.data);
      const kosdaqDeal = parseTransStyle(foreignBuyKosdaqResult.data);
      foreignBuy = [...kospiDeal.foreign, ...kosdaqDeal.foreign];
      institutionBuy = [...kospiDeal.institution, ...kosdaqDeal.institution];

      // 외국인/기관 순매도: 거래량 상위 종목들의 수급 데이터에서 집계
      let foreignSell = [], institutionSell = [];
      try {
        // 거래량 상위 30종목의 수급 데이터를 개별 조회
        const topCodes = volumeRanking.slice(0, 30).map(s => s.itemCode).filter(Boolean);
        const dealResults = await Promise.allSettled(
          topCodes.map(code => proxyRequest(`${mobileBase}/stock/${code}/integration`))
        );
        const dealStocks = [];
        dealResults.forEach((r, i) => {
          if (r.status !== 'fulfilled') return;
          try {
            const data = JSON.parse(r.value.data);
            const trend = (data.dealTrendInfos || [])[0]; // 최신 거래일
            if (!trend) return;
            const fgn = parseInt(String(trend.foreignerPureBuyQuant || '0').replace(/[+,]/g, ''), 10);
            const org = parseInt(String(trend.organPureBuyQuant || '0').replace(/[+,]/g, ''), 10);
            dealStocks.push({
              code: topCodes[i],
              name: data.stockName || volumeRanking[i]?.stockName || '',
              price: trend.closePrice || '',
              foreignNet: fgn,
              organNet: org,
            });
          } catch (_) {}
        });
        // 외국인 순매도 (음수가 큰 순)
        foreignSell = dealStocks
          .filter(s => s.foreignNet < 0)
          .sort((a, b) => a.foreignNet - b.foreignNet)
          .slice(0, 7)
          .map(s => ({ code: s.code, name: s.name, price: s.price, net: s.foreignNet.toLocaleString() }));
        // 기관 순매도 (음수가 큰 순)
        institutionSell = dealStocks
          .filter(s => s.organNet < 0)
          .sort((a, b) => a.organNet - b.organNet)
          .slice(0, 7)
          .map(s => ({ code: s.code, name: s.name, price: s.price, net: s.organNet.toLocaleString() }));
      } catch (_e) {}

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        kospiUp: kospiUpData,
        kosdaqUp: kosdaqUpData,
        volumeRanking,
        investorTrend,
        foreignBuy,
        institutionBuy,
        foreignSell,
        institutionSell,
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API 프록시: /api/naver?url=...
  if (parsedUrl.pathname === '/api/naver') {
    const targetUrl = parsedUrl.searchParams.get('url');
    if (!targetUrl || (!targetUrl.startsWith('https://m.stock.naver.com/') && !targetUrl.startsWith('https://finance.naver.com/') && !targetUrl.startsWith('https://ac.stock.naver.com/'))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid URL. Only m.stock.naver.com allowed.' }));
      return;
    }

    try {
      const result = await proxyRequest(targetUrl);
      res.writeHead(result.statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(result.data);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // AI 분석 리포트: /api/ai-report?code=005930 또는 ?name=삼성전자
  if (parsedUrl.pathname === '/api/ai-report') {
    if (!process.env.ANTHROPIC_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다. Render 환경변수를 확인해주세요.' }));
      return;
    }

    const codeParam = parsedUrl.searchParams.get('code');
    const nameParam = parsedUrl.searchParams.get('name');

    try {
      const mobileBase = 'https://m.stock.naver.com/api';
      let stockCode = codeParam || '';
      let stockName = nameParam || '';

      // 종목명 → 코드 변환
      if (!stockCode && stockName) {
        const r = await proxyRequest(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(stockName)}&target=stock`);
        const d = JSON.parse(r.data);
        const item = (d.items || []).find(i => i.category === 'stock');
        if (item) { stockCode = item.code; stockName = item.name; }
      }

      if (!stockCode) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '종목을 찾을 수 없습니다.' }));
        return;
      }

      // 캐시 확인 (1시간)
      const cached = aiReportCache.get(stockCode);
      if (cached && Date.now() - cached.ts < AI_CACHE_TTL) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(cached.data));
        return;
      }

      // 병렬로 Naver 데이터 + 뉴스 + 분기실적 + 연간차트 + 연간재무 요청
      const [basicRes, integRes, quarterRes, newsRes, yearChartRes, annualRes] = await Promise.allSettled([
        proxyRequest(`${mobileBase}/stock/${stockCode}/basic`),
        proxyRequest(`${mobileBase}/stock/${stockCode}/integration`),
        proxyRequest(`${mobileBase}/stock/${stockCode}/finance/quarter`),
        proxyRequestEucKr(`https://finance.naver.com/item/news_news.naver?code=${stockCode}&page=1`),
        proxyRequest(`${mobileBase}/stock/${stockCode}/yearChart`),
        proxyRequest(`${mobileBase}/stock/${stockCode}/finance/annual`),
      ]);

      let basic = null, integ = null, quarterData = null, annualData = null;
      try { if (basicRes.status === 'fulfilled') basic = JSON.parse(basicRes.value.data); } catch (_) {}
      try { if (integRes.status === 'fulfilled') integ = JSON.parse(integRes.value.data); } catch (_) {}
      try { if (quarterRes.status === 'fulfilled') quarterData = JSON.parse(quarterRes.value.data); } catch (_) {}
      try { if (annualRes.status === 'fulfilled') annualData = JSON.parse(annualRes.value.data); } catch (_) {}

      // ── 펀더멘탈 파싱 ──
      const fundamental = { periods: [], rows: [] };
      try {
        // 연간 데이터 (finance/annual)
        const fi = annualData?.financeInfo;
        if (fi?.trTitleList?.length && fi?.rowList?.length) {
          fundamental.periods = fi.trTitleList.slice(-4).map(t => ({
            key: t.key, title: t.title || t.key, isConsensus: t.isConsensus === 'Y',
          }));
          const wantRows = ['매출액', '당기순이익', 'PER', 'PBR', 'EPS', 'BPS', 'EV/EBITDA', 'EBITDA', 'DPS', '배당수익률', 'ROE', 'ROA'];
          fundamental.rows = fi.rowList
            .filter(r => wantRows.some(w => r.title && r.title.includes(w)))
            .map(r => ({
              title: r.title,
              values: fundamental.periods.map(p => {
                const col = r.columns?.[p.key];
                return col?.value != null ? col.value : '-';
              }),
            }));
        }
      } catch (_) {}

      // 연간 API 실패 시 integration totalInfos로 폴백
      if (fundamental.rows.length === 0 && integ?.totalInfos) {
        const infosMap = {};
        integ.totalInfos.forEach(item => { if (item.code) infosMap[item.code] = item.value; });
        const metricMap = [
          ['PER(배)', 'per'], ['PBR(배)', 'pbr'], ['EPS(원)', 'eps'],
          ['BPS(원)', 'bps'], ['배당수익률(%)', 'dividendYieldRatio'],
          ['ROE(%)', 'roe'], ['ROA(%)', 'roa'], ['부채비율(%)', 'debtRatio'],
        ];
        fundamental.periods = [{ key: 'current', title: '현재', isConsensus: false }];
        fundamental.rows = metricMap
          .filter(([, code]) => infosMap[code] != null)
          .map(([title, code]) => ({ title, values: [infosMap[code]] }));
        // 분기 데이터에서 매출액·순이익 추가
        try {
          const qfi = quarterData?.financeInfo;
          if (qfi) {
            const pnq = v => { if (!v) return 0; return parseFloat(String(v).replace(/,/g, '')) || 0; };
            const confirmed = (qfi.trTitleList || []).filter(t => t.isConsensus === 'N').map(t => t.key).sort().reverse();
            if (confirmed.length >= 1) {
              const k1 = confirmed[0];
              const t1 = qfi.trTitleList.find(t => t.key === k1);
              let qRevenue = 0, qNetIncome = 0;
              for (const row of (qfi.rowList || [])) {
                const col = row.columns?.[k1];
                if (!col) continue;
                if (row.title === '매출액') qRevenue = pnq(col.value);
                if (row.title === '당기순이익') qNetIncome = pnq(col.value);
              }
              if (qRevenue > 0) {
                fundamental.periods = [{ key: 'current', title: t1?.title || k1, isConsensus: false }];
                fundamental.rows.unshift({ title: '매출액', values: [qRevenue] });
              }
              if (qNetIncome !== 0) {
                fundamental.rows.splice(qRevenue > 0 ? 1 : 0, 0, { title: '당기순이익', values: [qNetIncome] });
              }
            }
          }
        } catch (_) {}
      }

      // 최근 뉴스 헤드라인 + URL 파싱
      const headlines = [];
      try {
        if (newsRes.status === 'fulfilled') {
          const newsHtml = newsRes.value.data;
          const newsPattern = /<td class="title"[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
          let nm;
          while ((nm = newsPattern.exec(newsHtml)) !== null && headlines.length < 5) {
            const url = nm[1].trim();
            const title = nm[2].trim();
            if (title && title.length > 5) {
              headlines.push({
                title,
                url: url.startsWith('http') ? url : 'https://finance.naver.com' + url,
              });
            }
          }
        }
      } catch (_) {}

      stockName = basic?.stockName || stockName;

      // 시장구분 및 업종
      const marketType = basic?.stockExchangeType?.name || '';
      const sector = basic?.industryCodeType?.name || '';

      function pn(v) { if (!v) return 0; return parseFloat(String(v).replace(/,/g, '')) || 0; }

      const price = pn(basic?.closePrice);
      const direction = basic?.compareToPreviousPrice?.name || '';
      const rawRate = pn(basic?.fluctuationsRatio);
      const changeRate = (direction === 'FALLING' || direction === 'LOWER_LIMIT') ? -Math.abs(rawRate) : rawRate;

      // integration totalInfos 파싱
      let per = 0, pbr = 0, marketCap = '', high52 = 0, low52 = 0;
      let eps = 0, bps = 0, divYield = 0, roe = 0;
      if (integ?.totalInfos) {
        const infos = {};
        integ.totalInfos.forEach(item => { if (item.code || item.key) infos[item.code || item.key] = item.value; });
        per = pn(infos.per); pbr = pn(infos.pbr);
        marketCap = infos.marketValue || '';
        high52 = pn(infos.highPriceOf52Weeks);
        low52 = pn(infos.lowPriceOf52Weeks);
        eps = pn(infos.eps); bps = pn(infos.bps);
        divYield = pn(infos.dividendYieldRatio);
        roe = pn(infos.roe);
      }

      // 분기 실적 파싱
      let latestRevenue = 0, latestOp = 0, prevRevenue = 0, prevOp = 0, revPeriod = '';
      try {
        if (quarterData?.financeInfo) {
          const fi = quarterData.financeInfo;
          const confirmed = (fi.trTitleList || [])
            .filter(t => t.isConsensus === 'N').map(t => t.key).sort().reverse();
          if (confirmed.length >= 1) {
            const k1 = confirmed[0];
            const t1 = fi.trTitleList.find(t => t.key === k1);
            revPeriod = t1?.title || k1;
            for (const row of (fi.rowList || [])) {
              const col = row.columns?.[k1];
              if (!col) continue;
              if (row.title === '매출액') latestRevenue = pn(col.value);
              if (row.title === '영업이익') latestOp = pn(col.value);
            }
          }
          if (confirmed.length >= 2) {
            const k2 = confirmed[1];
            for (const row of (fi.rowList || [])) {
              const col = row.columns?.[k2];
              if (!col) continue;
              if (row.title === '매출액') prevRevenue = pn(col.value);
              if (row.title === '영업이익') prevOp = pn(col.value);
            }
          }
        }
      } catch (_) {}

      // 수급 데이터 (최근 5일)
      const deals = integ?.dealTrendInfos || [];
      let foreignTotal = 0, organTotal = 0;
      deals.slice(0, 5).forEach(d => {
        foreignTotal += pn(d.foreignerPureBuyQuant);
        organTotal += pn(d.organPureBuyQuant);
      });

      // ── Bull / Bear 자동 생성 ──
      const bull = [], bear = [];

      // 1. 외국인 수급
      if (foreignTotal > 0) bull.push(`외국인 최근 5일 순매수 ${Math.abs(foreignTotal).toLocaleString()}주 — 외국계 자금 유입 지속`);
      else if (foreignTotal < 0) bear.push(`외국인 최근 5일 순매도 ${Math.abs(foreignTotal).toLocaleString()}주 — 외국계 자금 이탈`);

      // 2. 기관 수급
      if (organTotal > 0) bull.push(`기관 최근 5일 순매수 ${Math.abs(organTotal).toLocaleString()}주 — 기관 매집 신호`);
      else if (organTotal < 0) bear.push(`기관 최근 5일 순매도 ${Math.abs(organTotal).toLocaleString()}주 — 기관 차익실현 중`);

      // 3. 52주 위치
      if (high52 > 0 && low52 > 0 && price > 0) {
        const pos = (price - low52) / (high52 - low52) * 100;
        if (pos < 30) bull.push(`52주 저점(${low52.toLocaleString()}원) 근처 — 저점 매수 구간 진입, 저점 대비 +${((price-low52)/low52*100).toFixed(1)}%`);
        else if (pos > 80) bear.push(`52주 고점(${high52.toLocaleString()}원) 근처 — 고점 부담, 고점 대비 ${((price-high52)/high52*100).toFixed(1)}%`);
      }

      // 4. PER 밸류에이션
      if (per > 0) {
        if (per < 10) bull.push(`PER ${per.toFixed(1)}배 — 역사적 저평가 수준, 밸류에이션 매력도 높음`);
        else if (per < 15) bull.push(`PER ${per.toFixed(1)}배 — 코스피 평균 대비 저평가 구간`);
        else if (per > 40) bear.push(`PER ${per.toFixed(1)}배 — 고평가 부담, 실적 성장 없으면 추가 상승 제한적`);
        else if (per > 25) bear.push(`PER ${per.toFixed(1)}배 — 업종 평균 대비 다소 높은 밸류에이션`);
      }

      // 5. 분기 실적 성장
      if (latestRevenue > 0 && prevRevenue > 0) {
        const revGrowth = ((latestRevenue - prevRevenue) / prevRevenue * 100).toFixed(1);
        if (latestRevenue > prevRevenue) bull.push(`${revPeriod} 매출액 전분기 대비 +${revGrowth}% 증가 — 실적 성장세 확인`);
        else bear.push(`${revPeriod} 매출액 전분기 대비 ${revGrowth}% 감소 — 실적 둔화 우려`);
      }
      if (latestOp !== 0 && prevOp !== 0) {
        if (latestOp > prevOp && latestOp > 0) bull.push(`영업이익 전분기 대비 증가 (${latestOp.toLocaleString()}억원) — 수익성 개선 추세`);
        else if (latestOp < 0) bear.push(`${revPeriod} 영업손실 ${Math.abs(latestOp).toLocaleString()}억원 — 흑자전환 여부 모니터링`);
      }

      // 6. PBR/배당
      if (pbr > 0 && pbr < 1) bull.push(`PBR ${pbr.toFixed(2)}배 — 순자산 대비 저평가, 하방 리스크 제한적`);
      if (divYield > 3) bull.push(`배당수익률 ${divYield.toFixed(2)}% — 높은 배당 매력으로 하방 지지`);

      // 뉴스 헤드라인 기반 포인트
      if (headlines.length > 0) {
        const posKw = ['수주', '성장', '흑자', '급등', '돌파', '매수', '호실적', '증가', '상승', '최대'];
        const negKw = ['하락', '손실', '적자', '부진', '우려', '하향', '매도', '감소', '악화', '리스크'];
        headlines.forEach(h => {
          if (bull.length < 4 && posKw.some(k => h.title.includes(k))) bull.push(`[뉴스] ${h.title}`);
          if (bear.length < 4 && negKw.some(k => h.title.includes(k))) bear.push(`[뉴스] ${h.title}`);
        });
      }

      // 부족분 채우기
      const bullDefaults = ['중장기 실적 모멘텀 개선 여부 지속 모니터링 필요', '업종 내 상대적 밸류에이션 경쟁력 보유', '배당 및 자사주 매입 등 주주환원 정책 기대'];
      const bearDefaults = ['글로벌 경기 불확실성에 따른 업종 전반 리스크 존재', '환율·금리 변동에 따른 실적 변동성 주의', '수급 공백 시 단기 변동성 확대 가능성'];
      while (bull.length < 3) bull.push(bullDefaults[bull.length]);
      while (bear.length < 3) bear.push(bearDefaults[bear.length]);

      // ── 연간 차트 → 이동평균 + 직전 저점 계산 ──
      let ma20 = 0, ma60 = 0, recentSwingLow = 0;
      try {
        if (yearChartRes.status === 'fulfilled') {
          const chartData = JSON.parse(yearChartRes.value.data);
          const prices = (chartData.priceInfos || chartData || [])
            .map(p => pn(p.closePrice || p.close_price || p))
            .filter(p => p > 0);
          if (prices.length >= 20) {
            const last20 = prices.slice(-20);
            ma20 = Math.round(last20.reduce((a, b) => a + b, 0) / 20);
          }
          if (prices.length >= 60) {
            const last60 = prices.slice(-60);
            ma60 = Math.round(last60.reduce((a, b) => a + b, 0) / 60);
          } else if (prices.length > 0) {
            ma60 = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
          }
          // 직전 저점: 최근 60일 일봉에서 가장 최근 스윙로우 탐색
          const recent = prices.slice(-60);
          for (let i = recent.length - 2; i >= 1; i--) {
            if (recent[i] < recent[i - 1] && recent[i] < recent[i + 1]) {
              recentSwingLow = recent[i];
              break;
            }
          }
          // 스윙로우 없으면 최근 20일 최저가 사용
          if (!recentSwingLow && recent.length >= 20) {
            recentSwingLow = Math.min(...recent.slice(-20));
          }
        }
      } catch (_) {}

      // ── 매수가 3종 계산 ──
      // 매수가① 이동평균선 기반: MA20·MA60 중 현재가 아래의 더 높은 값
      let buy1 = 0;
      if (ma20 > 0 || ma60 > 0) {
        const candidates = [ma20, ma60].filter(m => m > 0 && m < price);
        buy1 = candidates.length > 0 ? Math.max(...candidates) : Math.round(price * 0.92);
      } else {
        buy1 = Math.round(price * 0.92);
      }

      // 매수가③ 직전저점 + MA20 기준: 두 값의 중간값
      const buy3 = recentSwingLow > 0 && ma20 > 0
        ? Math.round((recentSwingLow + ma20) / 2)
        : recentSwingLow > 0
          ? Math.round(recentSwingLow * 1.02)
          : ma20 > 0 ? Math.round(ma20 * 0.97) : Math.round(price * 0.91);

      // 매수가② 피보나치 기반: 52주 고저 구간의 되돌림 레벨 중 현재가 바로 아래
      let buy2 = 0;
      if (high52 > 0 && low52 > 0) {
        const range = high52 - low52;
        const fibLevels = [
          Math.round(high52 - range * 0.236),
          Math.round(high52 - range * 0.382),
          Math.round(high52 - range * 0.500),
          Math.round(high52 - range * 0.618),
        ];
        const below = fibLevels.filter(l => l < price);
        buy2 = below.length > 0 ? Math.max(...below) : fibLevels[0];
      } else {
        buy2 = Math.round(price * 0.90);
      }

      // ── 저항선 / 지지선 ──
      const resistance1 = high52 > price
        ? Math.min(Math.round(price * 1.15), Math.round(high52 * 0.97))
        : Math.round(price * 1.15);
      const resistance2 = high52 > price
        ? Math.round(high52 * 0.99)
        : Math.round(price * 1.35);
      const support = low52 > 0
        ? Math.max(Math.round(low52 * 1.01), Math.round(price * 0.87))
        : Math.round(price * 0.87);

      const pos52 = (high52 > 0 && low52 > 0)
        ? Math.round((price - low52) / (high52 - low52) * 100)
        : null;

      const ma20Str = ma20 > 0 ? `MA20 ${ma20.toLocaleString()}원` : '';
      const ma60Str = ma60 > 0 ? `MA60 ${ma60.toLocaleString()}원` : '';
      const techComment = pos52 !== null
        ? `현재 52주 범위 내 ${pos52}% 위치. ${[ma20Str, ma60Str].filter(Boolean).join(', ')}. 1차 저항선(${resistance1.toLocaleString()}원) 돌파 시 2차 저항선(${resistance2.toLocaleString()}원) 목표.`
        : `${[ma20Str, ma60Str].filter(Boolean).join(', ')}. 1차 저항선 ${resistance1.toLocaleString()}원 돌파 여부가 핵심.`;

      const analysis = {
        bull: bull.slice(0, 3),
        bear: bear.slice(0, 3),
        technical: { buy1, buy2, buy3, ma20, ma60, recentSwingLow, resistance1, resistance2, support, comment: techComment },
      };

      // 재무 프로필
      const profile = { eps, bps, divYield, roe, latestRevenue, latestOp, revPeriod };

      const result = { code: stockCode, name: stockName, price, changeRate, marketCap, marketType, sector, per, pbr, high52, low52, headlines, profile, fundamental, analysis };
      aiReportCache.set(stockCode, { data: result, ts: Date.now() });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── 종합 스코어링: /api/scoring?code=005930
  if (parsedUrl.pathname === '/api/scoring') {
    const codeParam = parsedUrl.searchParams.get('code') || '';
    const nameParam = parsedUrl.searchParams.get('name') || '';
    if (!codeParam && !nameParam) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'code or name required' }));
      return;
    }
    try {
      const mobileBase = 'https://m.stock.naver.com/api';
      let stockCode = codeParam;
      let stockName = nameParam;
      if (!stockCode && stockName) {
        const r = await proxyRequest(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(stockName)}&target=stock`);
        const d = JSON.parse(r.data);
        const item = (d.items || []).find(i => i.category === 'stock');
        if (item) { stockCode = item.code; stockName = item.name; }
      }
      if (!stockCode) throw new Error('종목코드를 찾을 수 없습니다');

      const [basicRes, integRes, quarterRes, yearChartRes, annualRes] = await Promise.allSettled([
        proxyRequest(`${mobileBase}/stock/${stockCode}/basic`),
        proxyRequest(`${mobileBase}/stock/${stockCode}/integration`),
        proxyRequest(`${mobileBase}/stock/${stockCode}/finance/quarter`),
        proxyRequest(`${mobileBase}/stock/${stockCode}/yearChart`),
        proxyRequest(`${mobileBase}/stock/${stockCode}/finance/annual`),
      ]);

      let basic = null, integ = null, quarterData = null, annualData = null;
      try { if (basicRes.status === 'fulfilled') basic = JSON.parse(basicRes.value.data); } catch (_) {}
      try { if (integRes.status === 'fulfilled') integ = JSON.parse(integRes.value.data); } catch (_) {}
      try { if (quarterRes.status === 'fulfilled') quarterData = JSON.parse(quarterRes.value.data); } catch (_) {}
      try { if (annualRes.status === 'fulfilled') annualData = JSON.parse(annualRes.value.data); } catch (_) {}

      function pn(v) { if (!v) return 0; return parseFloat(String(v).replace(/,/g, '')) || 0; }

      stockName = basic?.stockName || stockName;
      const price = pn(basic?.closePrice);
      const marketType = basic?.stockExchangeType?.name || '';
      const sector = basic?.industryCodeType?.name || '';
      const direction = basic?.compareToPreviousPrice?.name || '';
      const rawRate = pn(basic?.fluctuationsRatio);
      const changeRate = (direction === 'FALLING' || direction === 'LOWER_LIMIT') ? -Math.abs(rawRate) : rawRate;

      // totalInfos 파싱
      const infos = {};
      if (integ?.totalInfos) integ.totalInfos.forEach(item => { if (item.code || item.key) infos[item.code || item.key] = item.value; });
      const per = pn(infos.per), pbr = pn(infos.pbr), eps = pn(infos.eps), roe = pn(infos.roe);
      const high52 = pn(infos.highPriceOf52Weeks), low52 = pn(infos.lowPriceOf52Weeks);
      const marketCap = infos.marketValue || '';
      const divYield = pn(infos.dividendYieldRatio);
      const debtRatio = pn(infos.debtRatio);

      // 차트 데이터에서 이동평균 계산 — ai-report와 완전히 동일한 방식
      // ── 이동평균 + 거래량: dealTrendInfos(최근 거래일 기준) 우선 사용 ──
      let ma20 = 0, ma60 = 0, ma5 = 0, currentVol = 0, avgVol20 = 0;
      try {
        const deals = integ?.dealTrendInfos || [];
        if (deals.length > 0) {
          // dealTrendInfos: 최신순 정렬되어 있음, 각 항목에 closePrice/stockEndPrice + volume
          const dealCloses = deals
            .map(d => pn(d.closePrice || d.stockEndPrice || d.endPrice || d.close))
            .filter(v => v > 0);
          const dealVols = deals
            .map(d => pn(d.accumulatedTradingVolume || d.tradingVolume || d.volume))
            .filter(v => v > 0);

          // 거래량: 가장 최근 거래일 vs 최근 20일 평균
          if (dealVols.length > 0) {
            currentVol = dealVols[0]; // 가장 최근 거래일
            avgVol20 = dealVols.slice(0, 20).reduce((a,b)=>a+b,0) / Math.min(dealVols.length, 20);
          }

          // dealTrendInfos가 충분하면 MA 계산에 활용 (보통 20~60일치 있음)
          if (dealCloses.length >= 5) {
            const rev = [...dealCloses].reverse(); // 오래된 순으로
            if (rev.length >= 5)  ma5  = rev.slice(-5).reduce((a,b)=>a+b,0)/5;
            if (rev.length >= 20) ma20 = rev.slice(-20).reduce((a,b)=>a+b,0)/20;
            if (rev.length >= 60) ma60 = rev.slice(-60).reduce((a,b)=>a+b,0)/60;
          }
        }
      } catch (_) {}

      // yearChart로 MA 보완 (dealTrendInfos가 부족할 때)
      try {
        if ((ma20 === 0 || ma60 === 0) && yearChartRes.status === 'fulfilled') {
          const chartRaw = JSON.parse(yearChartRes.value.data);
          const arr = chartRaw.priceInfos || chartRaw.chartInfos || (Array.isArray(chartRaw) ? chartRaw : []);
          const closes = arr.map(p => pn(p.closePrice || p.close_price || p.close || p)).filter(p => p > 0);
          if (closes.length >= 5  && ma5  === 0) ma5  = closes.slice(-5).reduce((a,b)=>a+b,0)/5;
          if (closes.length >= 20 && ma20 === 0) ma20 = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
          if (closes.length >= 60 && ma60 === 0) ma60 = closes.slice(-60).reduce((a,b)=>a+b,0)/60;
          else if (closes.length > 0 && ma60 === 0) ma60 = closes.reduce((a,b)=>a+b,0)/closes.length;
          // yearChart에서 거래량 보완
          if (avgVol20 === 0) {
            const vols = arr.map(p => pn(p.accumulatedTradingVolume || p.volume || p.tradingVolume)).filter(v => v > 0);
            if (vols.length > 0) {
              currentVol = vols[vols.length-1];
              avgVol20 = vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(vols.length, 20);
            }
          }
        }
      } catch (_) {}

      // 휴장일 fallback: basic 당일 거래량 (0이면 무시)
      if (currentVol === 0) currentVol = pn(basic?.accumulatedTradingVolume);
      if (avgVol20 === 0 && currentVol > 0) avgVol20 = currentVol;

      // ROE·부채비율 보강: annualData rowList에서 가져오기
      let roeVal = roe, debtVal = debtRatio;
      try {
        const fi = annualData?.financeInfo;
        if (fi?.rowList?.length && fi?.trTitleList?.length) {
          const lastKey = (fi.trTitleList.filter(t => t.isConsensus !== 'Y').pop() || fi.trTitleList[fi.trTitleList.length-1])?.key;
          if (lastKey) {
            for (const row of fi.rowList) {
              const col = row.columns?.[lastKey];
              if (!col) continue;
              if (row.title?.includes('ROE')) roeVal = pn(col.value);
              if (row.title?.includes('부채비율')) debtVal = pn(col.value);
            }
          }
        }
      } catch (_) {}

      // 분기 실적
      let revenue = 0, revPrev = 0, opProfit = 0, opPrev = 0, netIncome = 0;
      let revenueGrowth = 0, opGrowth = 0, opMargin = 0;
      try {
        const qfi = quarterData?.financeInfo;
        if (qfi) {
          const confirmed = (qfi.trTitleList||[]).filter(t=>t.isConsensus==='N').map(t=>t.key).sort().reverse();
          if (confirmed.length >= 1) {
            const k1 = confirmed[0];
            for (const row of (qfi.rowList||[])) {
              const col = row.columns?.[k1]; if (!col) continue;
              if (row.title === '매출액') revenue = pn(col.value);
              if (row.title === '영업이익') opProfit = pn(col.value);
              if (row.title === '당기순이익') netIncome = pn(col.value);
            }
          }
          if (confirmed.length >= 2) {
            const k2 = confirmed[1];
            for (const row of (qfi.rowList||[])) {
              const col = row.columns?.[k2]; if (!col) continue;
              if (row.title === '매출액') revPrev = pn(col.value);
              if (row.title === '영업이익') opPrev = pn(col.value);
            }
          }
          if (revPrev > 0) revenueGrowth = (revenue - revPrev) / revPrev * 100;
          if (opPrev > 0) opGrowth = (opProfit - opPrev) / opPrev * 100;
          if (revenue > 0) opMargin = opProfit / revenue * 100;
        }
      } catch (_) {}

      // ── 기술적 분석 스코어 (30점) ──
      let techScore = 0;
      const techDetail = {};

      // 1. 이동평균 배열 (6점): 가능한 데이터로 정배열 확인
      let maScore = 0;
      if (price > 0) {
        if (ma5 > 0 && ma20 > 0 && ma60 > 0) {
          // 완전한 정배열 판단
          if (price > ma5)  maScore += 1;
          if (ma5 > ma20)   maScore += 2;
          if (ma20 > ma60)  maScore += 2;
          if (price > ma60) maScore += 1;
        } else if (ma5 > 0 && ma20 > 0) {
          // MA5, MA20만 있을 때 (6점 만점 기준 비례)
          if (price > ma5)  maScore += 2;
          if (ma5 > ma20)   maScore += 3;
          if (price > ma20) maScore += 1;
        } else if (ma20 > 0) {
          if (price > ma20) maScore += 4;
          else maScore += 1;
        } else if (ma5 > 0) {
          if (price > ma5) maScore += 3;
          else maScore += 1;
        }
      }
      const maDesc = [ma5>0?`MA5(${Math.round(ma5).toLocaleString()})`:null, ma20>0?`MA20(${Math.round(ma20).toLocaleString()})`:null, ma60>0?`MA60(${Math.round(ma60).toLocaleString()})`:null].filter(Boolean).join(' ') || '데이터 부족';
      techDetail.ma = { score: maScore, max: 6, label: '이동평균 배열', desc: maDesc };
      techScore += maScore;

      // 2. MA20 괴리율 (6점): MA20 없으면 MA5로 대체
      let divScore = 3;
      const maRef = ma20 > 0 ? ma20 : ma5;
      const maRefLabel = ma20 > 0 ? 'MA20' : 'MA5';
      if (maRef > 0 && price > 0) {
        const div = (price - maRef) / maRef * 100;
        if (div >= -3 && div <= 5) divScore = 6;
        else if (div >= -8 && div <= 12) divScore = 4;
        else if (div >= -15 && div <= 20) divScore = 2;
        else divScore = 0;
        techDetail.divergence = { score: divScore, max: 6, label: `${maRefLabel} 괴리율`, desc: `현재가 ${maRefLabel} 대비 ${div.toFixed(1)}%` };
      } else {
        techDetail.divergence = { score: divScore, max: 6, label: 'MA20 괴리율', desc: '데이터 부족' };
      }
      techScore += divScore;

      // 3. 52주 위치 (5점)
      let pos52Score = 2;
      if (high52 > 0 && low52 > 0 && price > 0) {
        const pos = (price - low52) / (high52 - low52) * 100;
        if (pos >= 30 && pos <= 70) pos52Score = 5;
        else if (pos >= 20 && pos <= 80) pos52Score = 4;
        else if (pos >= 10 && pos <= 90) pos52Score = 3;
        else pos52Score = 1;
        techDetail.pos52 = { score: pos52Score, max: 5, label: '52주 위치', desc: `52주 범위 내 ${pos.toFixed(0)}% 위치` };
      } else {
        techDetail.pos52 = { score: pos52Score, max: 5, label: '52주 위치', desc: '데이터 부족' };
      }
      techScore += pos52Score;

      // 4. 모멘텀 등락률 (5점)
      let momScore = 2;
      if (changeRate > 3) momScore = 5;
      else if (changeRate > 1) momScore = 4;
      else if (changeRate >= -1) momScore = 3;
      else if (changeRate >= -3) momScore = 2;
      else momScore = 0;
      techDetail.momentum = { score: momScore, max: 5, label: '가격 모멘텀', desc: `당일 등락 ${changeRate > 0 ? '+' : ''}${changeRate.toFixed(2)}%` };
      techScore += momScore;

      // 5. 거래량 (8점)
      let volScore = 3;
      if (avgVol20 > 0 && currentVol > 0) {
        const volRatio = currentVol / avgVol20;
        if (volRatio >= 2) volScore = 8;
        else if (volRatio >= 1.5) volScore = 6;
        else if (volRatio >= 1) volScore = 4;
        else volScore = 2;
        techDetail.volume = { score: volScore, max: 8, label: '거래량', desc: `20일 평균 대비 ${(volRatio*100).toFixed(0)}%` };
      } else {
        techDetail.volume = { score: volScore, max: 8, label: '거래량', desc: '데이터 부족' };
      }
      techScore += volScore;

      // ── 펀더멘탈 스코어 (50점) ──
      let fundScore = 0;
      const fundDetail = {};

      // 1. PER (8점)
      let perScore = 0;
      if (per > 0) {
        if (per <= 10) perScore = 8;
        else if (per <= 15) perScore = 7;
        else if (per <= 20) perScore = 5;
        else if (per <= 30) perScore = 3;
        else if (per <= 50) perScore = 1;
        else perScore = 0;
        fundDetail.per = { score: perScore, max: 8, label: 'PER', desc: `${per.toFixed(1)}배` };
      } else {
        fundDetail.per = { score: 0, max: 8, label: 'PER', desc: '적자/데이터 없음' };
      }
      fundScore += perScore;

      // 2. PBR (7점)
      let pbrScore = 0;
      if (pbr > 0) {
        if (pbr <= 1) pbrScore = 7;
        else if (pbr <= 1.5) pbrScore = 6;
        else if (pbr <= 2) pbrScore = 4;
        else if (pbr <= 3) pbrScore = 2;
        else pbrScore = 0;
        fundDetail.pbr = { score: pbrScore, max: 7, label: 'PBR', desc: `${pbr.toFixed(2)}배` };
      } else {
        fundDetail.pbr = { score: 0, max: 7, label: 'PBR', desc: '데이터 없음' };
      }
      fundScore += pbrScore;

      // 3. ROE (5점)
      let roeScore = 0;
      if (roeVal > 0) {
        if (roeVal >= 20) roeScore = 5;
        else if (roeVal >= 15) roeScore = 4;
        else if (roeVal >= 10) roeScore = 3;
        else if (roeVal >= 5) roeScore = 2;
        else roeScore = 1;
        fundDetail.roe = { score: roeScore, max: 5, label: 'ROE', desc: `${roeVal.toFixed(1)}%` };
      } else {
        fundDetail.roe = { score: 0, max: 5, label: 'ROE', desc: '데이터 없음' };
      }
      fundScore += roeScore;

      // 4. 매출 성장률 (6점)
      let revGrowthScore = 0;
      if (revPrev > 0) {
        if (revenueGrowth >= 20) revGrowthScore = 6;
        else if (revenueGrowth >= 10) revGrowthScore = 5;
        else if (revenueGrowth >= 5) revGrowthScore = 4;
        else if (revenueGrowth >= 0) revGrowthScore = 3;
        else if (revenueGrowth >= -10) revGrowthScore = 1;
        else revGrowthScore = 0;
        fundDetail.revGrowth = { score: revGrowthScore, max: 6, label: '매출 성장률', desc: `${revenueGrowth.toFixed(1)}% (전분기 대비)` };
      } else {
        revGrowthScore = 2;
        fundDetail.revGrowth = { score: revGrowthScore, max: 6, label: '매출 성장률', desc: '데이터 부족' };
      }
      fundScore += revGrowthScore;

      // 5. 영업이익 성장률 (6점)
      let opGrowthScore = 0;
      if (opPrev !== 0) {
        if (opGrowth >= 30) opGrowthScore = 6;
        else if (opGrowth >= 15) opGrowthScore = 5;
        else if (opGrowth >= 5) opGrowthScore = 4;
        else if (opGrowth >= 0) opGrowthScore = 3;
        else if (opGrowth >= -20) opGrowthScore = 1;
        else opGrowthScore = 0;
        fundDetail.opGrowth = { score: opGrowthScore, max: 6, label: '영업이익 성장률', desc: `${opGrowth.toFixed(1)}% (전분기 대비)` };
      } else {
        opGrowthScore = 2;
        fundDetail.opGrowth = { score: opGrowthScore, max: 6, label: '영업이익 성장률', desc: '데이터 부족' };
      }
      fundScore += opGrowthScore;

      // 6. 영업이익률 (5점)
      let opMarginScore = 0;
      if (revenue > 0) {
        if (opMargin >= 20) opMarginScore = 5;
        else if (opMargin >= 10) opMarginScore = 4;
        else if (opMargin >= 5) opMarginScore = 3;
        else if (opMargin >= 0) opMarginScore = 1;
        else opMarginScore = 0;
        fundDetail.opMargin = { score: opMarginScore, max: 5, label: '영업이익률', desc: `${opMargin.toFixed(1)}%` };
      } else {
        opMarginScore = 2;
        fundDetail.opMargin = { score: opMarginScore, max: 5, label: '영업이익률', desc: '데이터 부족' };
      }
      fundScore += opMarginScore;

      // 7. 부채비율 (4점)
      let debtScore = 0;
      if (debtVal > 0) {
        if (debtVal <= 50) debtScore = 4;
        else if (debtVal <= 100) debtScore = 3;
        else if (debtVal <= 200) debtScore = 2;
        else if (debtVal <= 400) debtScore = 1;
        else debtScore = 0;
        fundDetail.debt = { score: debtScore, max: 4, label: '부채비율', desc: `${debtVal.toFixed(0)}%` };
      } else {
        debtScore = 2;
        fundDetail.debt = { score: debtScore, max: 4, label: '부채비율', desc: '데이터 부족' };
      }
      fundScore += debtScore;

      // 8. 배당수익률 (4점)
      let divScore2 = 0;
      if (divYield > 0) {
        if (divYield >= 4) divScore2 = 4;
        else if (divYield >= 2) divScore2 = 3;
        else if (divYield >= 1) divScore2 = 2;
        else divScore2 = 1;
        fundDetail.dividend = { score: divScore2, max: 4, label: '배당수익률', desc: `${divYield.toFixed(2)}%` };
      } else {
        fundDetail.dividend = { score: 0, max: 4, label: '배당수익률', desc: '무배당' };
      }
      fundScore += divScore2;

      // 9. EPS 양수 여부 (5점)
      let epsScore = eps > 0 ? 5 : 0;
      fundDetail.eps = { score: epsScore, max: 5, label: 'EPS (흑자여부)', desc: eps > 0 ? `${Math.round(eps).toLocaleString()}원` : '적자' };
      fundScore += epsScore;

      // ── 감성 스코어 (20점): 뉴스 키워드 기반 ──
      let sentScore = 10; // 중립 기본
      const sentDetail = {};
      try {
        const newsRes2 = await proxyRequestEucKr(`https://finance.naver.com/item/news_news.naver?code=${stockCode}&page=1`);
        const newsHtml = newsRes2.data;
        const titlePat = /<td class="title"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g;
        const titles = [];
        let nm;
        while ((nm = titlePat.exec(newsHtml)) !== null && titles.length < 10) titles.push(nm[1].trim());

        const posKw = ['급등','상승','호실적','신고가','매수','수주','흑자전환','목표가 상향','어닝서프라이즈','수출 증가','성장','호재','계약','협약','기대'];
        const negKw = ['급락','하락','적자','손실','리스크','위기','실망','매도','목표가 하향','어닝쇼크','악재','소송','규제','우려'];
        let posCount = 0, negCount = 0;
        titles.forEach(t => {
          posKw.forEach(k => { if (t.includes(k)) posCount++; });
          negKw.forEach(k => { if (t.includes(k)) negCount++; });
        });
        const sentDiff = posCount - negCount;
        if (sentDiff >= 3) sentScore = 20;
        else if (sentDiff === 2) sentScore = 17;
        else if (sentDiff === 1) sentScore = 14;
        else if (sentDiff === 0) sentScore = 10;
        else if (sentDiff === -1) sentScore = 7;
        else if (sentDiff === -2) sentScore = 4;
        else sentScore = 2;
        sentDetail.news = { score: sentScore, max: 20, label: '뉴스 감성', desc: `긍정 ${posCount}건 / 부정 ${negCount}건 (${titles.length}개 기사 분석)` };
      } catch (_) {
        sentDetail.news = { score: sentScore, max: 20, label: '뉴스 감성', desc: '뉴스 분석 실패 (중립 적용)' };
      }

      // ── 종합 스코어 ──
      const totalScore = Math.round(techScore + fundScore + sentScore);
      let grade = 'F';
      if (totalScore >= 90) grade = 'A+';
      else if (totalScore >= 80) grade = 'A';
      else if (totalScore >= 70) grade = 'B+';
      else if (totalScore >= 60) grade = 'B';
      else if (totalScore >= 50) grade = 'C+';
      else if (totalScore >= 40) grade = 'C';
      else if (totalScore >= 30) grade = 'D';
      else grade = 'F';

      const result = {
        code: stockCode, name: stockName, price, changeRate, marketType, sector,
        per, pbr, roe, eps, divYield, high52, low52, marketCap,
        score: { total: totalScore, grade, technical: techScore, fundamental: fundScore, sentiment: sentScore },
        techDetail, fundDetail, sentDetail,
      };

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 정적 파일 서빙
  let filePath = parsedUrl.pathname === '/' ? '/stock-dashboard.html' : parsedUrl.pathname;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  ✅ 주가 대시보드 서버 실행 중`);
  console.log(`  ➜ http://localhost:${PORT}\n`);
});
