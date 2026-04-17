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
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
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
        '바이오': [286, 261, 262, 281, 316],  // 생물공학 + 제약 + 바이오벤처 + 의료기기 + 헬스케어
        '자동차': [273, 270],        // 자동차 + 자동차부품
        '에너지': [295, 313, 325],   // 에너지장비 + 석유가스 + 전력
        '조선': [291],               // 조선
        '통신장비': [294, 333, 307], // 통신장비 + 무선통신 + 전자장비
        '우주항공': [284, 305],      // 방산/우주 + 항공
      };

      const mobileBase = 'https://m.stock.naver.com/api';
      const sectors = (parsedUrl.searchParams.get('sectors') || '').split(',').filter(Boolean);
      const result = {};

      const delay = ms => new Promise(r => setTimeout(r, ms));
      for (const sector of sectors) {
        const industryNos = SECTOR_MAP[sector];
        if (!industryNos) continue;
        const stockMap = {};
        const addStocks = (data) => {
          (data.stocks || []).forEach(s => {
            if (s.itemCode && s.itemCode.endsWith('0') && !stockMap[s.itemCode]) {
              const mv = parseFloat(String(s.marketValue || '0').replace(/,/g, '')) || 0;
              const exchange = (s.stockExchangeType?.name || s.reutersCode || '').toUpperCase();
              const market = exchange.includes('KOSDAQ') ? 'KOSDAQ' : 'KOSPI';
              stockMap[s.itemCode] = { mv, market };
            }
          });
        };
        // 1페이지 (최대 100개) 병렬 요청
        const results = await Promise.allSettled(
          industryNos.map(no =>
            proxyRequest(`${mobileBase}/stocks/industry/${no}?page=1&pageSize=100`)
          )
        );
        const needPage2 = [];
        for (let i = 0; i < results.length; i++) {
          if (results[i].status !== 'fulfilled') continue;
          try {
            const data = JSON.parse(results[i].value.data);
            addStocks(data);
            if ((data.totalCount || 0) > 100) needPage2.push(industryNos[i]);
          } catch (_) {}
        }
        // 100개 초과 업종은 2페이지 추가 요청
        if (needPage2.length > 0) {
          const p2 = await Promise.allSettled(
            needPage2.map(no =>
              proxyRequest(`${mobileBase}/stocks/industry/${no}?page=2&pageSize=100`)
            )
          );
          for (const r of p2) {
            if (r.status !== 'fulfilled') continue;
            try { addStocks(JSON.parse(r.value.data)); } catch (_) {}
          }
        }
        // KOSPI/KOSDAQ 각각 시총순 상위 20개씩
        const entries = Object.entries(stockMap);
        const kospi = entries.filter(([,v]) => v.market === 'KOSPI').sort((a,b) => b[1].mv - a[1].mv).slice(0, 20).map(([code]) => code);
        const kosdaq = entries.filter(([,v]) => v.market === 'KOSDAQ').sort((a,b) => b[1].mv - a[1].mv).slice(0, 20).map(([code]) => code);
        result[sector] = [...new Set([...kospi, ...kosdaq])].slice(0, 40);
        await delay(300); // 섹터 간 딜레이로 과부하 방지
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
            const linkMatch = r.match(/href="(company_read\.naver\?[^"]*)"/);
            const reportUrl = linkMatch ? 'https://finance.naver.com/research/' + linkMatch[1].replace(/&amp;/g, '&') : '';
            reports.push({
              stockCode: codeMatch ? codeMatch[1] : '',
              stockName: tds[0] || '',
              title: titleMatch ? titleMatch[1].trim() : '',
              broker: tds[2] || '',
              date: tds[4] || '',
              views: tds[5] || '',
              pdfUrl: pdfMatch ? pdfMatch[1] : '',
              reportUrl,
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
            const linkMatch = r.match(/href="(company_read\.naver\?[^"]*)"/);
            const reportUrl = linkMatch ? 'https://finance.naver.com/research/' + linkMatch[1].replace(/&amp;/g, '&') : '';
            const tdTexts = tds.map(t => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
            reports.push({
              title: titleMatch ? titleMatch[1].trim() : '',
              broker: tdTexts[2] || '',
              date: tdTexts[4] || '',
              views: tdTexts[5] || '',
              pdfUrl: pdfMatch ? pdfMatch[1] : '',
              reportUrl,
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


  // ── 차트매매 분석: /api/chart-analysis?code=005930 ──
  if (parsedUrl.pathname === '/api/chart-analysis') {
    const codeParam = parsedUrl.searchParams.get('code') || '';
    const nameParam = parsedUrl.searchParams.get('name') || '';
    if (!codeParam && !nameParam) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'code or name required' }));
      return;
    }
    try {
      const mobileBase = 'https://m.stock.naver.com/api';
      let stockCode = codeParam, stockName = nameParam;
      if (!stockCode && stockName) {
        const r = await proxyRequest(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(stockName)}&target=stock`);
        const d = JSON.parse(r.data);
        const item = (d.items || []).find(i => i.category === 'stock');
        if (item) { stockCode = item.code; stockName = item.name; }
      }
      if (!stockCode) throw new Error('종목코드를 찾을 수 없습니다');

      // 병렬로 기본정보 + integration + 일봉차트(fchart XML) 요청
      const [basicRes, integRes, dailyRes] = await Promise.allSettled([
        proxyRequest(`${mobileBase}/stock/${stockCode}/basic`),
        proxyRequest(`${mobileBase}/stock/${stockCode}/integration`),
        proxyRequest(`https://fchart.stock.naver.com/sise.nhn?symbol=${stockCode}&timeframe=day&count=150&requestType=0`),
      ]);

      let basic = null, integ = null;
      try { if (basicRes.status === 'fulfilled') basic = JSON.parse(basicRes.value.data); } catch (_) {}
      try { if (integRes.status === 'fulfilled') integ = JSON.parse(integRes.value.data); } catch (_) {}

      function pn(v) { if (!v) return 0; return parseFloat(String(v).replace(/,/g, '')) || 0; }
      stockName = basic?.stockName || stockName;

      // ETF/펀드/리츠 등 비주식 종목 체크
      const endType = basic?.stockEndType || '';
      if (['etf', 'etn', 'elw', 'fund', 'reits'].includes(endType.toLowerCase())) {
        throw new Error(`${stockName}은(는) ${endType.toUpperCase()} 종목으로 차트매매 분석 대상이 아닙니다.`);
      }

      const price = pn(basic?.closePrice);
      const marketType = basic?.stockExchangeType?.name || '';
      const sector = basic?.industryCodeType?.name || '';
      const infos = {};
      (integ?.totalInfos || []).forEach(i => { if (i.code) infos[i.code] = i.value; });
      const high52 = pn(infos.highPriceOf52Weeks), low52 = pn(infos.lowPriceOf52Weeks);
      const marketCap = infos.marketValue || '';

      // 일봉 OHLCV 파싱 (fchart XML: <item data="YYYYMMDD|시가|고가|저가|종가|거래량" />)
      let candles = [];
      try {
        if (dailyRes.status === 'fulfilled') {
          const xml = dailyRes.value.data;
          const itemPattern = /data="([^"]+)"/g;
          let match;
          while ((match = itemPattern.exec(xml)) !== null) {
            const parts = match[1].split('|');
            if (parts.length >= 6) {
              const [dateStr, open, high, low, close, vol] = parts;
              candles.push({
                date: `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`,
                open: +open, high: +high, low: +low, close: +close, volume: +vol,
              });
            }
          }
          candles = candles.filter(c => c.close > 0);
        }
      } catch (_) {}

      // fchart 실패 시 dealTrendInfos로 폴백
      if (candles.length < 30) {
        try {
          const deals = integ?.dealTrendInfos || [];
          if (deals.length >= 30) {
            candles = deals.map(d => ({
              date: d.date,
              open: pn(d.closePrice), high: pn(d.closePrice),
              low: pn(d.closePrice), close: pn(d.closePrice),
              volume: pn(d.accumulatedTradingVolume),
            })).filter(c => c.close > 0).reverse();
          }
        } catch (_) {}
      }

      // 주봉 대체: dealTrendInfos에서 추출 (최근 거래일 데이터)
      let weekCandles = [];
      try {
        const deals = integ?.dealTrendInfos || [];
        // 5일 단위로 묶어서 주봉 생성
        for (let i = 0; i < Math.min(deals.length, 50); i += 5) {
          const chunk = deals.slice(i, i+5);
          if (chunk.length === 0) break;
          weekCandles.push({
            date: chunk[0].date,
            close: pn(chunk[0].closePrice || chunk[0].accumulatedTradingValue),
          });
        }
      } catch (_) {}

      if (candles.length < 30) throw new Error(`차트 데이터가 부족합니다 (현재 ${candles.length}일, 최소 30일 필요)`);

      // ── 기술지표 계산 ──
      const closes = candles.map(c => c.close);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const volumes = candles.map(c => c.volume);
      const n = closes.length;

      // 이동평균
      const sma = (arr, p) => {
        if (arr.length < p) return 0;
        return arr.slice(-p).reduce((a,b) => a+b, 0) / p;
      };
      const ma5 = sma(closes, 5), ma20 = sma(closes, 20);
      const ma60 = closes.length >= 60 ? sma(closes, 60) : 0;
      const ma120 = closes.length >= 120 ? sma(closes, 120) : 0;
      const volMa5 = sma(volumes, 5), volMa20 = sma(volumes, 20);

      // 이동평균 기울기 (최근 5일간 변화)
      const maSlope = (arr, period) => {
        if (arr.length < period + 5) return 0;
        const cur = sma(arr.slice(-period), period);
        const prev = sma(arr.slice(-(period+5), -5), period);
        return prev > 0 ? ((cur - prev) / prev * 100) : 0;
      };
      const ma20Slope = maSlope(closes, 20);
      const ma60Slope = closes.length >= 65 ? maSlope(closes, 60) : 0;

      // RSI(14)
      let rsi = 50;
      if (n >= 15) {
        let gains = 0, losses = 0;
        for (let i = n-14; i < n; i++) {
          const diff = closes[i] - closes[i-1];
          if (diff > 0) gains += diff; else losses -= diff;
        }
        const avgGain = gains / 14, avgLoss = losses / 14;
        rsi = avgLoss === 0 ? 100 : Math.round(100 - 100 / (1 + avgGain / avgLoss) * 10) / 10;
      }

      // MACD(12,26,9)
      const ema = (arr, p) => {
        if (arr.length < p) return arr[arr.length-1] || 0;
        const k = 2 / (p + 1);
        let e = arr.slice(0, p).reduce((a,b)=>a+b,0) / p;
        for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1-k);
        return e;
      };
      const ema12 = ema(closes, 12), ema26 = ema(closes, 26);
      const macdLine = ema12 - ema26;
      // signal line approximation
      const macdHist = [];
      if (n >= 35) {
        const k12 = 2/13, k26 = 2/27;
        let e12 = closes.slice(0,12).reduce((a,b)=>a+b,0)/12;
        let e26 = closes.slice(0,26).reduce((a,b)=>a+b,0)/26;
        const macdArr = [];
        for (let i = 0; i < n; i++) {
          if (i >= 12) e12 = closes[i]*k12 + e12*(1-k12);
          if (i >= 26) e26 = closes[i]*k26 + e26*(1-k26);
          if (i >= 25) macdArr.push(e12 - e26);
        }
        const k9 = 2/10;
        let sig = macdArr.slice(0,9).reduce((a,b)=>a+b,0)/9;
        for (let i = 9; i < macdArr.length; i++) sig = macdArr[i]*k9 + sig*(1-k9);
        var macdSignal = sig;
        var macdValue = macdArr[macdArr.length-1];
        // 골든크로스 체크 (직전 vs 현재)
        let prevMacd = macdArr.length >= 2 ? macdArr[macdArr.length-2] : macdValue;
        var macdGoldenCross = prevMacd < sig && macdValue >= sig;
      } else {
        var macdSignal = 0, macdValue = macdLine, macdGoldenCross = false;
      }

      // 볼린저밴드(20,2)
      let bbUpper = 0, bbLower = 0, bbMiddle = ma20;
      if (n >= 20) {
        const slice20 = closes.slice(-20);
        const mean = slice20.reduce((a,b)=>a+b,0)/20;
        const std = Math.sqrt(slice20.reduce((a,b)=>a+(b-mean)**2,0)/20);
        bbMiddle = mean; bbUpper = mean + 2*std; bbLower = mean - 2*std;
      }

      // ATR(14)
      let atr = 0;
      if (n >= 15) {
        let trSum = 0;
        for (let i = n-14; i < n; i++) {
          const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
          trSum += tr;
        }
        atr = trSum / 14;
      }

      // 최근 고저점
      const high20 = Math.max(...highs.slice(-20));
      const low20 = Math.min(...lows.slice(-20));
      const high60 = highs.length >= 60 ? Math.max(...highs.slice(-60)) : high20;
      const low60 = lows.length >= 60 ? Math.min(...lows.slice(-60)) : low20;

      // 전고점 (60일 내 가장 높은 고가)
      const prevHigh = high60;

      // 갭 여부 (당일)
      const lastC = candles[n-1], prevC = candles[n-2];
      const gapUp = lastC.low > prevC.high;
      const gapDown = lastC.high < prevC.low;

      // 장대양봉/음봉 (당일 body가 ATR 1.5배 이상)
      const bodySize = Math.abs(lastC.close - lastC.open);
      const isBigBullish = lastC.close > lastC.open && bodySize > atr * 1.5;
      const isBigBearish = lastC.close < lastC.open && bodySize > atr * 1.5;

      // 거래량 급증
      const volRatio = volMa20 > 0 ? (volumes[n-1] / volMa20) : 1;

      // ── 추세 판별 ──
      const isJungBae = ma5 > ma20 && (ma60 === 0 || ma20 > ma60) && (ma120 === 0 || ma60 > ma120 || ma60 === 0);
      const isYeokBae = ma5 < ma20 && (ma60 === 0 || ma20 < ma60);
      let trend = '박스권';
      if (ma20Slope > 0.5 && ma60Slope >= 0) trend = '상승추세';
      else if (ma20Slope < -0.5 && ma60Slope <= 0) trend = '하락추세';

      // 상위 추세: 60일선 기울기 기반으로 판단
      const weekTrend = ma60 > 0 ? (ma60Slope > 0.3 ? '상승' : ma60Slope < -0.3 ? '하락' : '횡보') :
        (candles.length >= 40 ? (closes[n-1] > sma(closes, 40) ? '상승' : '하락') : '확인불가');

      let alignment = '혼조';
      if (isJungBae) alignment = '정배열';
      else if (isYeokBae) alignment = '역배열';

      // ── 지지선/저항선 ──
      // 피봇 포인트 기반
      const pivot = (lastC.high + lastC.low + lastC.close) / 3;
      const r1 = 2 * pivot - lastC.low;
      const s1 = 2 * pivot - lastC.high;
      const r2 = pivot + (lastC.high - lastC.low);
      const s2 = pivot - (lastC.high - lastC.low);

      // 주요 지지/저항
      const resistances = [high20, prevHigh, r1, r2, bbUpper].filter(v => v > price).sort((a,b)=>a-b);
      const supports = [low20, ma20, ma60, s1, s2, bbLower].filter(v => v > 0 && v < price).sort((a,b)=>b-a);

      const resistance1 = resistances[0] || Math.round(price * 1.1);
      const resistance2 = resistances[1] || Math.round(price * 1.2);
      const support1 = supports[0] || Math.round(price * 0.95);
      const support2 = supports[1] || Math.round(price * 0.9);

      // ── 매수 시그널 판단 ──
      const buySignals = [];
      const excludeSignals = [];

      // 매수 시그널
      if (price > ma20 && price < ma20 * 1.05 && ma20Slope > -0.1)
        buySignals.push('20일선 지지 후 반등');
      if (price > high20 * 0.96 && volRatio > 1.2)
        buySignals.push('박스권 상단 돌파 + 거래량 증가');
      if (price > prevHigh * 0.95 && volRatio > 1.2)
        buySignals.push('전고점 돌파 시도 + 거래량 동반');
      if (isJungBae && ma20Slope > 0)
        buySignals.push('정배열 초기 전환');
      if (macdGoldenCross)
        buySignals.push('MACD 골든크로스');
      if (rsi >= 35 && rsi <= 70 && closes[n-1] > closes[n-2])
        buySignals.push('RSI 건강한 상승 구간 ('+rsi+')');
      if (isBigBullish && price >= ma20 * 0.95)
        buySignals.push('눌림목 장대양봉 출현');
      if (price > bbMiddle && closes[n-2] < bbMiddle)
        buySignals.push('볼린저밴드 중심선 재돌파');
      if (price > ma5 && ma5 > ma20 && closes[n-1] > closes[n-2])
        buySignals.push('단기 이평선 정배열 상승');
      if (price >= ma60 * 0.97 && price <= ma60 * 1.03 && ma60Slope > -0.1)
        buySignals.push('60일선 지지 구간');

      // 매수 제외 조건
      if (price > high20 && volRatio < 0.8)
        excludeSignals.push('거래량 없이 돌파');
      if (rsi > 80)
        excludeSignals.push('RSI 과열 (' + rsi + ')');
      if (isBigBearish && closes[n-1] < closes[n-2] && closes[n-1] < ma20)
        excludeSignals.push('장대음봉 후 회복 실패');
      if (ma20Slope < -0.5 && ma60Slope < -0.5)
        excludeSignals.push('20일선·60일선 모두 하향');
      if (price > ma20 * 1.20)
        excludeSignals.push('이격 과다 (MA20 대비 +' + ((price/ma20-1)*100).toFixed(1) + '%)');

      // ── 매매가 산출 (현재 지지/저항 레벨 기반) ──

      // 최근 스윙로우 (20일 내 저점)
      const recentSwingLow = low20;

      // 매수가 후보: 현재 시점의 지지 레벨 기반
      // 1순위 지지: 가장 가까운 이평선 지지 또는 BB 중심선
      // 2순위 지지: 다음 이평선 또는 BB 하단
      // 3순위 지지: 더 깊은 지지선 또는 스윙로우
      const nearSupports = [ma5, ma20, bbMiddle, s1].filter(v => v > 0 && v < price).sort((a,b) => b-a);
      const deepSupports = [ma60, bbLower, s2, recentSwingLow].filter(v => v > 0 && v < price).sort((a,b) => b-a);
      const deepestSupports = [ma120, support2].filter(v => v > 0 && v < price).sort((a,b) => b-a);

      let aggressiveBuy, conservativeBuy, additionalBuy;

      // 공격적 매수: 가장 가까운 지지선 (1차 눌림목)
      if (nearSupports.length > 0) {
        aggressiveBuy = Math.round(nearSupports[0]);
      } else {
        aggressiveBuy = Math.round(price * 0.98);
      }

      // 보수적 매수: 중간 지지선 (MA60, BB하단 등)
      if (deepSupports.length > 0) {
        conservativeBuy = Math.round(deepSupports[0]);
      } else if (nearSupports.length > 1) {
        conservativeBuy = Math.round(nearSupports[nearSupports.length - 1]);
      } else {
        conservativeBuy = Math.round(price * 0.95);
      }

      // 추가매수: 깊은 지지선 (MA120, 스윙로우 등)
      if (deepestSupports.length > 0) {
        additionalBuy = Math.round(deepestSupports[0]);
      } else if (deepSupports.length > 1) {
        additionalBuy = Math.round(deepSupports[deepSupports.length - 1]);
      } else {
        additionalBuy = Math.round(price * 0.92);
      }

      // 매수가 순서 보장: 공격적 > 보수적 > 추가매수
      if (aggressiveBuy > price) aggressiveBuy = Math.round(price * 0.98);
      if (conservativeBuy >= aggressiveBuy) conservativeBuy = Math.round(aggressiveBuy * 0.96);
      if (additionalBuy >= conservativeBuy) additionalBuy = Math.round(conservativeBuy * 0.96);
      if (conservativeBuy <= 0) conservativeBuy = Math.round(price * 0.95);
      if (additionalBuy <= 0) additionalBuy = Math.round(price * 0.90);

      // 매수 근거 표시
      const buyMethods = [];
      if (nearSupports.length > 0) {
        const lvl = nearSupports[0];
        if (Math.abs(lvl - ma5) < atr * 0.3) buyMethods.push(`MA5 지지선 (${Math.round(ma5).toLocaleString()}원)`);
        else if (Math.abs(lvl - ma20) < atr * 0.3) buyMethods.push(`MA20 지지선 (${Math.round(ma20).toLocaleString()}원)`);
        else if (Math.abs(lvl - bbMiddle) < atr * 0.3) buyMethods.push(`볼린저밴드 중심선 (${Math.round(bbMiddle).toLocaleString()}원)`);
        else buyMethods.push(`피봇 지지선 S1 (${Math.round(s1).toLocaleString()}원)`);
      }
      if (deepSupports.length > 0) {
        const lvl = deepSupports[0];
        if (ma60 > 0 && Math.abs(lvl - ma60) < atr * 0.3) buyMethods.push(`MA60 지지선 (${Math.round(ma60).toLocaleString()}원)`);
        else if (Math.abs(lvl - bbLower) < atr * 0.3) buyMethods.push(`볼린저밴드 하단 (${Math.round(bbLower).toLocaleString()}원)`);
        else buyMethods.push(`피봇 지지선 S2 (${Math.round(s2).toLocaleString()}원)`);
      }
      if (deepestSupports.length > 0) {
        const lvl = deepestSupports[0];
        if (ma120 > 0 && Math.abs(lvl - ma120) < atr * 0.3) buyMethods.push(`MA120 장기 지지 (${Math.round(ma120).toLocaleString()}원)`);
        else buyMethods.push(`주요 지지선 (${Math.round(lvl).toLocaleString()}원)`);
      }

      // 손절가: 주요 지지선 아래 ATR 버퍼 (스윙로우 하방)
      const stopBase = Math.min(support1, recentSwingLow);
      const stopLoss = Math.round(stopBase - atr * 0.5);

      // 공통: 스윙 범위 / 추세 보정 계수
      const swingRange = high20 - low20;
      // 추세가 강할수록 목표가를 위로 끌어올림 (최대 +18%)
      let trendBoost = 1.0;
      if (isJungBae) trendBoost += 0.05;            // 정배열
      if (ma20Slope > 0.5) trendBoost += 0.05;      // 강한 단기 상승
      if (ma60Slope > 0.3) trendBoost += 0.05;      // 강한 중기 상승
      if (volRatio > 1.5) trendBoost += 0.03;       // 거래량 동반
      trendBoost = Math.min(trendBoost, 1.18);

      // 목표가 1,2: 현실적 (다중 차트분석 기법 융합)
      // (1) 가까운 저항선 (2) ATR 변동성 투영 (3) 측정이동(Measured Move)
      // (4) 피보나치 1.272 확장 → 가중평균 후 추세 보정

      // 1차: 저항1 + 3ATR + 0.5 측정이동 평균
      const t1_atrProj   = aggressiveBuy + atr * 3;
      const t1_measured  = aggressiveBuy + swingRange * 0.5;
      const t1_avg       = (resistance1 + t1_atrProj + t1_measured) / 3;
      let target1        = Math.round(Math.max(resistance1, t1_avg * trendBoost));

      // 2차: 저항2 + 5ATR + 1.0 측정이동 + 피보나치 1.272 평균
      const t2_atrProj   = aggressiveBuy + atr * 5;
      const t2_measured  = aggressiveBuy + swingRange * 1.0;
      const t2_fib1272   = high20 + swingRange * 0.272;
      const t2_avg       = (resistance2 + t2_atrProj + t2_measured + t2_fib1272) / 4;
      let target2        = Math.round(Math.max(target1 * 1.03, t2_avg * trendBoost));

      // 목표가 3,4: 공격적 (R/R 비율 + 피보나치 확장)
      const risk = aggressiveBuy - stopLoss;
      const minTarget3 = Math.round(aggressiveBuy + risk * 1.5);
      const minTarget4 = Math.round(aggressiveBuy + risk * 2.5);
      const fib1618 = Math.round(high20 + swingRange * 0.618);
      const fib2618 = Math.round(high20 + swingRange * 1.618);
      const target3 = Math.max(target2, minTarget3, fib1618);
      const target4 = Math.max(target3, minTarget4, fib2618);

      // 기대수익/손실 (현실적 목표 기준)
      const expectedReturn1 = price > 0 ? ((target1 - price) / price * 100) : 0;
      const expectedReturn2 = price > 0 ? ((target2 - price) / price * 100) : 0;
      const expectedReturn3 = price > 0 ? ((target3 - price) / price * 100) : 0;
      const expectedReturn4 = price > 0 ? ((target4 - price) / price * 100) : 0;
      const expectedLoss = price > 0 ? ((stopLoss - price) / price * 100) : 0;
      const riskReward = Math.abs(expectedLoss) > 0 ? (expectedReturn1 / Math.abs(expectedLoss)) : 0;

      // ── 종합 판단 ──
      let grade = '진입 금지';
      const buyScore = buySignals.length;
      const excludeScore = excludeSignals.length;

      if (buyScore >= 3 && excludeScore === 0 && riskReward >= 1.2) grade = '강한 매수 후보';
      else if (buyScore >= 2 && excludeScore <= 1 && riskReward >= 0.8) grade = '조건부 매수 후보';
      else if (buyScore >= 1 && trend !== '하락추세') grade = '눌림 대기';
      else if (excludeScore <= 2) grade = '보유 관찰';
      else grade = '진입 금지';

      // 경고
      const warnings = [];
      if (volRatio > 5) warnings.push('거래량 왜곡 가능성 (평균 대비 ' + volRatio.toFixed(1) + '배)');
      if (gapUp && bodySize > atr * 2) warnings.push('갭 과열 종목');
      if (expectedReturn1 < 3) warnings.push('기대수익률 미미');
      if (riskReward < 1.5) warnings.push('손익비 부족 (R/R ' + riskReward.toFixed(2) + ')');

      // 차트패턴 요약
      let patternSummary = '';
      if (price > high20 && volRatio > 1.5) patternSummary = '박스권 돌파';
      else if (price > ma20 && price < ma20 * 1.03) patternSummary = '20일선 눌림목';
      else if (price < ma20 && price > ma60) patternSummary = '단기 조정 중';
      else if (price > bbUpper) patternSummary = '볼린저밴드 상단 이탈 (과열)';
      else if (price < bbLower) patternSummary = '볼린저밴드 하단 이탈 (과매도)';
      else if (isBigBullish) patternSummary = '장대양봉 출현';
      else if (isBigBearish) patternSummary = '장대음봉 출현';
      else patternSummary = trend === '상승추세' ? '상승 추세 진행' : trend === '하락추세' ? '하락 추세 진행' : '박스권 횡보';

      const result = {
        code: stockCode, name: stockName, price, marketType, sector, marketCap,
        high52, low52,
        analysis: {
          trend: { upper: weekTrend, short: trend, alignment, ma20Slope: +ma20Slope.toFixed(2), ma60Slope: +ma60Slope.toFixed(2) },
          indicators: {
            ma: { ma5: Math.round(ma5), ma20: Math.round(ma20), ma60: Math.round(ma60), ma120: Math.round(ma120) },
            rsi, macd: { value: +macdValue.toFixed(2), signal: +macdSignal.toFixed(2), goldenCross: macdGoldenCross },
            bb: { upper: Math.round(bbUpper), middle: Math.round(bbMiddle), lower: Math.round(bbLower) },
            atr: Math.round(atr),
            volume: { current: volumes[n-1], ma5: Math.round(volMa5), ma20: Math.round(volMa20), ratio: +volRatio.toFixed(2) },
          },
          levels: { high20, low20, high60, low60, prevHigh, resistance1, resistance2, support1, support2 },
          pattern: patternSummary,
          gap: gapUp ? '갭상승' : gapDown ? '갭하락' : '없음',
          bigCandle: isBigBullish ? '장대양봉' : isBigBearish ? '장대음봉' : '없음',
        },
        trading: {
          grade,
          prices: {
            aggressiveBuy, conservativeBuy, additionalBuy, stopLoss, target1, target2, target3, target4,
          },
          returns: {
            expectedReturn1: +expectedReturn1.toFixed(2),
            expectedReturn2: +expectedReturn2.toFixed(2),
            expectedReturn3: +expectedReturn3.toFixed(2),
            expectedReturn4: +expectedReturn4.toFixed(2),
            expectedLoss: +expectedLoss.toFixed(2),
            riskReward: +riskReward.toFixed(2),
          },
          buySignals, excludeSignals, warnings, buyMethods,
          strategy: {
            entry: buySignals.length >= 2 ? `${buySignals.slice(0,2).join(' + ')} 확인 시 진입` : '조건 충족 대기',
            hold: buySignals.length > 0 ? '진입 후 보류 조건: ' + (excludeSignals[0] || '없음') : '진입 불가',
            exit: `1차(${target1.toLocaleString()}원) 20% 매도 → 2차(${target2.toLocaleString()}원) 30% → 3차(${target3.toLocaleString()}원) 30% → 4차(${target4.toLocaleString()}원) 잔량 매도`,
            stopDesc: `손절가(${stopLoss.toLocaleString()}원) 이탈 시 전량 매도 (스윙로우 ${recentSwingLow.toLocaleString()}원 하방 ATR 버퍼)`,
          },
        },
        candles: candles.slice(-150).map(c => ({ d: c.date, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
      };

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── 집중 종목 분석 레포트: /api/deep-report ──
  if (parsedUrl.pathname === '/api/deep-report' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { stockCode, stockName, financialData, irNote } = JSON.parse(body);
        if (!stockCode) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '종목코드가 필요합니다.' }));
          return;
        }

        const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim().replace(/[^\x20-\x7E]/g, '');
        if (!OPENAI_API_KEY) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'OPENAI_API_KEY가 설정되지 않았습니다. Render 환경변수를 확인해주세요.' }));
          return;
        }

        const prompt = `당신은 한국 증권 애널리스트입니다. 아래 종목의 재무 데이터를 기반으로 집중 기업분석 레포트를 작성해주세요.

종목명: ${stockName}
종목코드: ${stockCode}

=== 재무 데이터 ===
${financialData}

${irNote ? `=== IR 통화 내용 (참고) ===\n${irNote}\n` : ''}

아래 6개 섹션을 JSON 형식으로 작성해주세요. 각 섹션은 구체적이고 전문적이어야 합니다.
실제 증권사 리포트처럼 구체적인 수치와 논리적 근거를 포함해주세요.

응답 형식 (반드시 아래 JSON 구조를 지켜주세요):
{
  "business": {
    "model": "비즈니스 모델 설명 (매출구성, 주요제품/서비스, 고객군, 경쟁우위 등 3~5문단)",
    "ceo": "최대주주 및 CEO 정보 (경영진 역량, 지분구조 등 2~3문단)"
  },
  "investmentPoints": [
    {
      "title": "투자포인트 제목",
      "detail": "상세 설명 (3~5문단, 구체적 수치와 논거 포함)"
    }
  ],
  "financial": {
    "revenueAnalysis": "매출/이익 분석 (성장률, 추이, 전망 등 3~4문단)",
    "balanceSheet": "자본/부채 분석 (재무안정성, PBR 밴드 등 2~3문단)"
  },
  "valuation": {
    "method": "밸류에이션 방법론 설명",
    "targetPrice": "목표주가 산출 근거 및 제시 (PER/PBR/EV/EBITDA 등 활용)",
    "scenarios": "Bull/Neutral/Bear 시나리오별 목표가"
  },
  "risks": [
    {
      "title": "리스크 제목",
      "detail": "상세 설명 (2~3문단)"
    }
  ],
  "summary": "핵심 투자의견 요약 (5~7줄, 결론 중심)"
}

중요: 반드시 유효한 JSON만 출력하세요. 다른 텍스트는 포함하지 마세요.`;

        const openaiPayload = JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 4000,
        });

        const result = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Length': Buffer.byteLength(openaiPayload),
            },
          };
          const apiReq = https.request(options, apiRes => {
            let data = '';
            apiRes.on('data', chunk => data += chunk);
            apiRes.on('end', () => resolve({ statusCode: apiRes.statusCode, data }));
          });
          apiReq.on('error', reject);
          apiReq.setTimeout(60000, () => { apiReq.destroy(); reject(new Error('OpenAI API Timeout')); });
          apiReq.write(openaiPayload);
          apiReq.end();
        });

        if (result.statusCode !== 200) {
          let errMsg = 'OpenAI API 오류';
          try {
            const errData = JSON.parse(result.data);
            errMsg = errData.error?.message || JSON.stringify(errData.error) || errMsg;
          } catch (_) { errMsg = result.data || errMsg; }
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `OpenAI 오류 (${result.statusCode}): ${errMsg}` }));
          return;
        }

        const openaiRes = JSON.parse(result.data);
        const content = openaiRes.choices?.[0]?.message?.content || '';

        // JSON 파싱 시도
        let report;
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          report = JSON.parse(jsonMatch ? jsonMatch[0] : content);
        } catch (e) {
          report = { raw: content, parseError: true };
        }

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify({ report, stockCode, stockName }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
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
