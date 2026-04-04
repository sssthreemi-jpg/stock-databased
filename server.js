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

  // ── 업종별 종목 자동 로드: GET /api/industry?sectors=반도체,바이오,... ──
  if (parsedUrl.pathname === '/api/industry') {
    try {
      // 네이버 업종 번호 매핑
      const SECTOR_MAP = {
        '반도체': [278],
        '2차전지': [272, 306],  // 화학 + 전기장비 (2차전지 전용 업종 없음)
        '바이오': [286, 281, 316],  // 생물공학 + 건강관리장비 + 건강관리업체
        '자동차': [273, 270],  // 자동차 + 자동차부품
        '인터넷/플랫폼': [300, 287, 267],  // 양방향미디어 + 소프트웨어 + IT서비스
        '금융': [321, 330],  // 증권 + 생명보험
        '에너지': [295, 313],  // 에너지장비 + 석유와가스
        '조선': [291],
        '통신장비': [294, 333],  // 통신장비 + 무선통신
        '건설': [279],
        '로봇': [299, 282],  // 기계 + 전자장비
        '화장품': [297, 274],  // 가정용품 + 섬유의류
        '우주항공': [284],
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
              if (s.itemCode && !codes.find(c => c === s.itemCode)) {
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
