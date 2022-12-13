import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { request } from 'undici'
import cheerio from 'cheerio';
import https from 'https'
import http from 'http'
import { SocksProxyAgent } from 'socks-proxy-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const errorWordsPath = path.join(__dirname, '../error-words.json')

const headersOptions = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'accept-language': 'en-GB,en;q=0.9'
}

function cleanup(text) {
  return text.trim().replace(/\d/g, '').replace(/\//g, '');;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createSocksProxy(host, port, protocol) {
  const proxyOptions = `${protocol}://${host}:${port}`;
  const socksProxy = new SocksProxyAgent(proxyOptions);
  return {
    httpsAgent: socksProxy
  }
}

function createHttpProxy(host, port, protocol) {
  const httpsAgent = new https.Agent({ keepAlive: true })
  // const httpAgent = new http.Agent({ keepAlive: true })
  const proxy = {
    protocol,
    host,
    port
  }

  return {
    httpsAgent,
    // httpAgent,
    proxy
  }
}

async function createProxy() {
  const resProxy = await axios.get(`https://gimmeproxy.com/api/getProxy`)
  const dataProxy = await resProxy.data

  switch (dataProxy.protocol) {
    case 'https':
      const httpProxy = createHttpProxy(dataProxy.ip, dataProxy.port, dataProxy.protocol)
      return httpProxy
    case 'socks5':
      const socksProxy = createSocksProxy(dataProxy.ip, dataProxy.port, dataProxy.protocol)
      return socksProxy

    default:
      return {
        httpsAgent: new https.Agent({ keepAlive: true })
      }
  }

}

async function getDefinitions(word) {
  await sleep(10000 + Math.round(Math.random() * 10000))
  // const proxy = await createProxy()
  // const res = await axios.get(`https://kbbi.kemdikbud.go.id/entri/${word}`, {
  //   headers: {
  //     ...headersOptions
  //   },
  //   timeout: 60000, //optional
  //   ...proxy
  // })
  // console.log("🚀 ~ file: get.mjs ~ line 42 ~ res", res.data)
  const res = await request(`https://kbbi.kemdikbud.go.id/entri/${word}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      // 'Accept-Encoding': 'gzip, deflate, br',
      // 'Accept-Language': 'en-GB,en;q=0.9'
    },
  })
  const html = await res.body.text();
  const $ = cheerio.load(html);

  if (res.statusCode !== 200) {
    throw new Error('Rate limited');
  }

  const definisi = await Promise.all($('h2[style="margin-bottom:3px"]').toArray().map(async el => {
    const ejaan = cleanup($(el).find('span.syllable').text())
    $(el).find('span.syllable').remove();
    const tidakBaku = cleanup($(el).find('small b').text());
    $(el).find('small').remove();

    let sukuKata = cleanup($(el).text())
    let akarKata = null;
    if (sukuKata.includes('»')) {
      [akarKata, sukuKata] = sukuKata.split('»').map(s => s.trim());
    }

    const $list = $(el).nextAll('ul.adjusted-par, ol').first()
    const $firstResult = $list.find('li').first();
    if ($firstResult.text().includes('→')) {
      const $bentukBaku = $firstResult.find('a')
      const alt = cleanup($bentukBaku.text());
      const [bentukBakuSearch] = $bentukBaku.attr('href').split('/').reverse();
      const definisi = await getDefinitions(bentukBakuSearch);
      return {
        sukuKata,
        akarKata,
        ejaan: ejaan === '' ? sukuKata.replace(/\./g, '') : ejaan,
        baku: false,
        alt,
        makna: definisi[0].makna,
      }
    }

    const makna = [];

    $list.find('li').each((_, el) => {
      const $info = $(el).find('font[color="red"]').first();

      let tipe, tipeTeks, info = [];
      if ($info.length === 1) {
        $info.find('span').each((i, el) => {
          switch (i) {
            case 0: {
              const [type, typeText] = $(el).attr('title').split(':').map(s => s.trim().toLowerCase());
              tipe = type
              tipeTeks = typeText;
              break;
            }
            default: {
              const [source, sourceText] = $(el).attr('title').split(':').map(s => s.trim().toLowerCase());
              info.push({
                sumber: source,
                sumberTeks: sourceText === '-' ? null : sourceText,
              })
              break;
            }
          }
        })
      }

      const contoh = $(el).find('font[color="grey"]:nth-child(3)').text().trim();
      $(el).find("font").remove();
      const definisi = $(el).text().trim().replace(/:$/, '');

      makna.push({
        tipe,
        tipeTeks,
        definisi,
        contoh: contoh === '' ? null : contoh,
        info,
      })
    });

    const $prakategorial = $(el).nextAll('font[color="darkgreen"]').first()
    if (
      $list.length === 0 &&
      $prakategorial.length === 1
    ) {
      const [type, typeText] = $prakategorial.attr('title').split(':').map(s => s.trim().toLowerCase());

      makna.push({
        tipe: type,
        tipeTeks: typeText,
        referensi: $prakategorial.nextAll('font[color="grey"]').first().text().trim().split(',').map(s => s.trim()),
      })
    }

    return {
      sukuKata,
      akarKata,
      ejaan: ejaan === '' ? sukuKata.replace(/\./g, '') : ejaan,
      baku: true,
      alt: tidakBaku || null,
      makna,
    }
  }))

  return definisi
}

async function storeWordDefinition(word, definitions) {
  const storedFilePath = word.replace(/ /g, '_').toLowerCase() + '.json';

  await fs.writeFile(
    path.join(process.cwd(), 'data', storedFilePath),
    JSON.stringify(definitions, null, 2),
  )
}

async function getAllWords() {
  const { entries } = JSON.parse(await fs.readFile(path.join(__dirname, '../entries.json'), { encoding: 'utf-8' }))
  let words = entries
    .flatMap(entry => {
      const [rawWord] = entry.split("/").reverse();
      const word = decodeURIComponent(rawWord);
      if (word.includes('?')) {
        return []
      }

      return word;
    })
  return words
}

async function getAllCurrentWordsData() {
  const files = await fs.readdir(path.join(__dirname, '../data'))
  const kata = files.map(file => file.replaceAll('_', ' ').replace('.json', ''))
  await fs.writeFile(path.join(__dirname, '../') + 'current-words.json', JSON.stringify(kata))
  return kata
}

async function getAllErrorWords() {
  const errorWords = JSON.parse(await fs.readFile(errorWordsPath, { encoding: 'utf-8' })) || []
  return errorWords
}

const retry = (callback, times = 3) => {
  let numberOfTries = 0;
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      numberOfTries++;
      if (numberOfTries === times) {
        console.log(`Trying for the last time... (${times})`);
        clearInterval(interval);
      }
      try {
        await callback();
        clearInterval(interval);
        console.log(`Operation successful, retried ${numberOfTries} times.`);
        resolve();
      } catch (err) {
        console.log(`Unsuccessful, retried ${numberOfTries} times... ${err}`);
      }
    }, 2500);
  });
};

async function getAllRemainingWords() {
  const words = await getAllWords()
  const errorWords = await getAllErrorWords()
  const currentWords = await getAllCurrentWordsData();

  const remainingWords = []

  for (const word of words) {
    if (!currentWords.includes(word) && !errorWords.includes(word)) {
      remainingWords.push(word)
    }
  }

  return remainingWords
}

async function getAllWordsDefinition() {
  const remainingWords = await getAllRemainingWords()

  console.log(`Fetching definitions, ${remainingWords.length} words remaining`);
  let i = 1;
  for await (const word of remainingWords) {
    try {
      const definitions = await getDefinitions(word);
      if (definitions.length === 0) {
        const errorWords = await getAllErrorWords()
        errorWords.push(word)

        await fs.writeFile(errorWordsPath, JSON.stringify(errorWords))
        console.warn(`Word ${word} does not exist`);
        continue;
      }

      await storeWordDefinition(word, definitions);
      console.log(`${i}. Definition for word ${word} stored`);
      i++;
    } catch (err) {
      if (err?.message === 'Rate limited') {
        await sleep(5000)
        throw new Error(err.message)
      }

      const errorWords = await getAllErrorWords()
      errorWords.push(word)

      await fs.writeFile(errorWordsPath, JSON.stringify(errorWords))
      console.error(`Failed to get definitions for ${word}`, { err });
      throw new Error('Error')
    }
  }
}

async function syncCurrentData() {
  const remainingWords = await getAllRemainingWords()
  await fs.writeFile(path.join(__dirname, '../remaining-words.json'), JSON.stringify(remainingWords))

  const files = await fs.readdir(path.join(__dirname, '../data'))
  const kata = files.map(file => file.replaceAll('_', ' ').replace('.json', ''))
  await fs.writeFile(path.join(__dirname, '../') + 'current-words.json', JSON.stringify(kata))
}

(async function main() {
  // await getAllWordsDefinition()
  await syncCurrentData()
})()
