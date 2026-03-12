// @ts-check

/**
 * @typedef {object} DecoderResult
 * @property {VideoFrame[]} frames
 * @property {{ codec: string, codedWidth: number, codedHeight: number }} config
 */

/**
 * fMP4 init セグメントから H.264 コーデック情報を抽出する
 * stsd > avc1 > avcC box を解析して codec 文字列と description を取得
 * @param {ArrayBuffer} data
 * @returns {{ codec: string, codedWidth: number, codedHeight: number, description: Uint8Array } | null}
 */
export function extractH264Config(data) {
  const u8 = new Uint8Array(data);
  const view = new DataView(data);

  // avcC box を探す（再帰的に box 構造を探索）
  const result = findAvcCBox(u8, view, 0, u8.byteLength);
  if (!result) return null;

  const { avcCOffset, avcCSize, codedWidth, codedHeight } = result;

  // avcC box 内の profile, constraints, level を読み取る
  // avcC format: configurationVersion(1) + AVCProfileIndication(1) + profile_compatibility(1) + AVCLevelIndication(1) + ...
  const dataStart = avcCOffset + 8; // box header (size + type) をスキップ
  const profile = u8[dataStart + 1];
  const constraints = u8[dataStart + 2];
  const level = u8[dataStart + 3];

  const codec = `avc1.${profile.toString(16).padStart(2, '0')}${constraints.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;

  // avcC の raw data を description として渡す（box header の後のデータ）
  const description = u8.slice(dataStart, avcCOffset + avcCSize);

  return { codec, codedWidth, codedHeight, description };
}

/**
 * fMP4 init セグメントからオーディオ設定 (サンプルレート、チャンネル数) を抽出する
 * moov > trak > mdia > minf > stbl > stsd > mp4a box を解析
 * @param {ArrayBuffer} data
 * @returns {{ audioSampleRate: number, audioChannels: number, audioDescription?: Uint8Array } | null}
 */
export function extractAudioConfig(data) {
  const u8 = new Uint8Array(data);
  const view = new DataView(data);
  const boxes = parseBoxes(u8, 0, u8.byteLength);

  const moov = findBox(boxes, 'moov');
  if (!moov) return null;

  const trak = findBox(moov.children || [], 'trak');
  if (!trak) return null;

  const mdia = findBox(trak.children || [], 'mdia');
  if (!mdia) return null;

  // mdhd からは本来の timescale が取れるが今回は mp4a から直接取る
  const minf = findBox(mdia.children || [], 'minf');
  if (!minf) return null;

  const stbl = findBox(minf.children || [], 'stbl');
  if (!stbl) return null;

  const stsd = findBox(stbl.children || [], 'stsd');
  if (!stsd) return null;

  // mp4a (AAC) を探す
  const mp4a = findBoxDeep(stsd, 'mp4a');
  if (!mp4a) return null;

  const mp4aDataStart = mp4a.offset + 8;
  const channels = view.getUint16(mp4aDataStart + 16);

  // esds (Elementary Stream Descriptor) box を探す
  const esds = findBoxDeep(mp4a, 'esds');
  let sampleRate = 48000; // Default
  /** @type {Uint8Array | undefined} */
  let audioDescription = undefined;

  if (esds) {
    const data = u8.subarray(esds.dataOffset, esds.offset + esds.size);
    // eSDS box: version(1), flags(3), then descriptors
    let pos = 4;

    // Descriptor tag (0x03=ES, 0x04=DecoderConfig, 0x05=DecoderSpecificInfo)
    // 各タグは可変長 (1-4 バイト) の長さを持つ可能性があるため、再帰的または順次的に解析
    function getDescriptor(pos) {
      if (pos >= data.length) return null;
      const tag = data[pos];
      let len = 0;
      let p = pos + 1;
      let b = 0;
      do {
        b = data[p++];
        len = (len << 7) | (b & 0x7F);
      } while (b & 0x80 && p < data.length);
      return { tag, len, headerSize: p - pos, dataPos: p };
    }

    let p = 4;
    const es = getDescriptor(p);
    if (es && es.tag === 0x03) {
      p = es.dataPos + 3; // skip ES_ID(2), flags(1)
      const dc = getDescriptor(p);
      if (dc && dc.tag === 0x04) {
        p = dc.dataPos + 13; // skip ObjectType(1), StreamType(1), buffer(3), maxBitrate(4), avg(4)
        const dsi = getDescriptor(p);
        if (dsi && dsi.tag === 0x05) {
          audioDescription = data.slice(dsi.dataPos, dsi.dataPos + dsi.len);

          // サンプルレートの取得
          const asc = (audioDescription[0] << 8) | audioDescription[1];
          const freqIndex = (asc >> 7) & 0x0F;
          const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
          if (freqIndex < sampleRates.length) {
            sampleRate = sampleRates[freqIndex];
          }
        }
      }
    }

    // fallback: simple search if structural parsing fails
    if (!audioDescription) {
      for (let i = 0; i < data.length - 4; i++) {
        if (data[i] === 0x05) {
          let len = data[i+1];
          if (len > 0 && len < 64 && i + 2 + len <= data.length) {
             audioDescription = data.slice(i + 2, i + 2 + len);
             const asc = (audioDescription[0] << 8) | audioDescription[1];
             const freqIndex = (asc >> 7) & 0x0F;
             const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
             if (freqIndex < sampleRates.length) sampleRate = sampleRates[freqIndex];
             break;
          }
        }
      }
    }
  }

  // フォールバック：mp4a の値を読み取る
  if (!audioDescription) {
    const sr = view.getUint32(mp4aDataStart + 24) >>> 16;
    if (sr >= 8000 && sr <= 192000) sampleRate = sr;
  }

  console.log(`[NicoCommentDL] Detected audio config: ${channels} channels, ${sampleRate}Hz, ASC length: ${audioDescription?.length || 0}`);
  return { audioSampleRate: sampleRate, audioChannels: channels, audioDescription };
}

/**
 * fMP4 init セグメントから timescale を抽出する
 * @param {ArrayBuffer} data
 * @param {number} [fallback] - 検出失敗時のデフォルト値
 * @returns {number}
 */
export function extractTimescale(data, fallback = 1) {
  const u8 = new Uint8Array(data);
  const view = new DataView(data);
  const boxes = parseBoxes(u8, 0, u8.byteLength);

  const mdhd = findBoxDeepFromMany(boxes, 'mdhd');
  if (mdhd) {
    const ver = u8[mdhd.dataOffset];
    return view.getUint32(mdhd.dataOffset + (ver === 0 ? 12 : 20));
  }

  const mvhd = findBoxDeepFromMany(boxes, 'mvhd');
  if (mvhd) {
    const ver = u8[mvhd.dataOffset];
    return view.getUint32(mvhd.dataOffset + (ver === 0 ? 12 : 20));
  }

  return fallback;
}

/**
 * Box 構造を再帰的に探索して avcC box の位置を見つける
 * @param {Uint8Array} u8
 * @param {DataView} view
 * @param {number} start
 * @param {number} end
 * @returns {{ avcCOffset: number, avcCSize: number, codedWidth: number, codedHeight: number } | null}
 */
function findAvcCBox(u8, view, start, end) {
  const containerTypes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  let offset = start;
  let codedWidth = 0;
  let codedHeight = 0;

  while (offset < end - 8) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > end) break;
    const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);

    if (type === 'avcC') {
      return { avcCOffset: offset, avcCSize: size, codedWidth, codedHeight };
    }

    if (type === 'stsd') {
      // stsd: version(4) + entry_count(4) + entries...
      // entry 内の avc1 box を探す
      const stsdDataStart = offset + 8 + 8; // box header + fullbox header
      return findAvcCBox(u8, view, stsdDataStart, offset + size);
    }

    if (type === 'avc1' || type === 'avc3') {
      // avc1/avc3 box: 6 bytes reserved + 2 data_ref_index + 16 predefined + 2 width + 2 height + ...
      // avc1/avc3 box の幅と高さを読み取る
      const avc1DataStart = offset + 8;
      codedWidth = view.getUint16(avc1DataStart + 24);
      codedHeight = view.getUint16(avc1DataStart + 26);
      // avc1 内のサブ box を探す（avcC 等）
      const subBoxStart = avc1DataStart + 78; // avc1 fixed fields
      const result = findAvcCBox(u8, view, subBoxStart, offset + size);
      if (result) {
        result.codedWidth = codedWidth;
        result.codedHeight = codedHeight;
      }
      return result;
    }

    if (containerTypes.has(type)) {
      const result = findAvcCBox(u8, view, offset + 8, offset + size);
      if (result) return result;
    }

    offset += size;
  }
  return null;
}

/**
 * CMAF ビデオデータをデコードして VideoFrame の配列を返す
 * @param {ArrayBuffer | Array<{ data: ArrayBuffer, timestamp: number, duration: number, isKeyframe: boolean }>} videoDataOrChunks - init + メディアセグメント結合済みデータ、またはチャンク配列
 * @param {(frame: VideoFrame) => void | Promise<void>} onFrame - フレーム受信コールバック
 * @param {object} [codecConfig] - コーデック設定
 * @param {object} [options] - 追加オプション (timescale 等)
 * @returns {Promise<void>}
 */
export async function decodeVideo(videoDataOrChunks, onFrame, codecConfig, options = {}) {
  return new Promise(async (resolve, reject) => {
    let rejected = false;
    /** @type {Array<Promise<void>>} */
    const framePromises = [];

    // デコーダー作成
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          const result = onFrame(frame);
          if (result instanceof Promise) {
            framePromises.push(result);
          }
        } catch (err) {
          const e = /** @type {any} */ (err);
          frame.close();
          if (!rejected) {
            rejected = true;
            reject(e);
          }
        }
      },
      error: (e) => {
        console.error('[VideoDecoder] Error:', e);
        if (!rejected) {
          rejected = true;
          reject(new Error(`VideoDecoder error: ${e.message}`));
        }
      },
    });

    // コーデック設定
    let config = codecConfig;
    if (!config && videoDataOrChunks instanceof ArrayBuffer) {
      const h264Config = extractH264Config(videoDataOrChunks);
      if (h264Config) {
        config = {
          codec: h264Config.codec,
          codedWidth: h264Config.codedWidth,
          codedHeight: h264Config.codedHeight,
          description: h264Config.description,
        };
      }
    }

    if (!config) {
      config = codecConfig || { codec: 'avc1.64001f' };
    }

    try {
      // デコーダーを設定（同期的）
      // @ts-ignore
      decoder.configure(config);
      console.log('[decodeVideo] Decoder configured:', config.codec);
    } catch (e) {
      rejected = true;
      try { decoder.close(); } catch (_) {}
      reject(new Error(`VideoDecoder configure error: ${/** @type {any} */ (e).message}`));
      return;
    }

    // チャンク抽出
    const chunks = Array.isArray(videoDataOrChunks) ? videoDataOrChunks : extractVideoChunks(videoDataOrChunks, options);

    try {
      for (const chunk of chunks) {
        if (rejected) break;
        if (!chunk.data || chunk.data.byteLength === 0) continue;

        decoder.decode(new EncodedVideoChunk({
          type: chunk.isKeyframe ? 'key' : 'delta',
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          data: chunk.data,
        }));
      }

      if (!rejected) {
        await decoder.flush();
        // すべてのオンフレーム処理（エンコード待ちなど）が終わるのを待つ
        await Promise.all(framePromises);
        decoder.close();
        resolve();
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (!rejected) {
        rejected = true;
        try { decoder.close(); } catch (_) {}
        reject(new Error(`VideoDecoder decode error: ${e.message}`));
      }
    }
  });
}

/**
 * fMP4 バイナリからビデオチャンクを抽出する簡易パーサー
 * MP4 の Box 構造を解析して mdat 内のサンプルを取得
 * @param {ArrayBuffer} data
 * @param {object} [options]
 * @returns {Array<{ data: ArrayBuffer, timestamp: number, duration: number, isKeyframe: boolean }>}
 */
export function extractVideoChunks(data, options = {}) {
  const view = new DataView(data);
  /** @type {any[]} */
  const chunks = [];
  const boxes = parseBoxes(new Uint8Array(data), 0, data.byteLength);

  const moof_mdat = extractMoofMdat(new Uint8Array(data));

  // Fragmented MP4 の場合
  if (moof_mdat.length > 0) {
    // @ts-ignore
    return extractFragmentedChunks(new Uint8Array(data), view, /** @type {any} */ (options).timescale);
  }

  // moov box からサンプル情報を取得
  const moov = findBox(boxes, 'moov');
  if (!moov) return chunks;

  const trak = findBox(moov.children || [], 'trak');
  if (!trak) return chunks;

  // stbl (Sample Table) を取得
  const mdia = findBox(trak.children || [], 'mdia');
  if (!mdia) return chunks;

  const minf = findBox(mdia.children || [], 'minf');
  if (!minf) return chunks;

  const stbl = findBox(minf.children || [], 'stbl');
  if (!stbl) return chunks;

  // サンプルテーブルから情報を抽出
  const sampleInfo = parseSampleTable(stbl, new Uint8Array(data));

  // 通常の MP4
  const mdat = findBox(boxes, 'mdat');
  if (!mdat) return chunks;

  let offset = 0;
  for (const sample of sampleInfo) {
    chunks.push({
      data: data.slice(mdat.dataOffset + offset, mdat.dataOffset + offset + sample.size),
      timestamp: sample.timestamp,
      duration: sample.duration,
      isKeyframe: sample.isKeyframe,
    });
    offset += sample.size;
  }

  return chunks;
}

/**
 * Fragmented MP4 (fMP4/CMAF) からチャンクを抽出
 * moof/mdat ペアを順に処理し、trun のサンプル情報に基づき mdat からデータを切り出す
 * @param {Uint8Array} data
 * @param {DataView} view
 * @param {number} [externalTimescale]
 * @returns {Array<{ data: ArrayBuffer, timestamp: number, duration: number, isKeyframe: boolean }>}
 */
function extractFragmentedChunks(data, view, externalTimescale) {
  const chunks = [];
  const boxes = parseBoxes(data, 0, data.byteLength);
  let timescale = externalTimescale || 1;

  if (!externalTimescale) {
    // まず moov から timescale を取得
    const topBoxes = parseBoxes(data, 0, data.byteLength);
    const moov = findBox(topBoxes, 'moov');
    if (moov) {
      // mdhd の timescale を優先（トラック固有）
      const mdhd = findBoxDeep(moov, 'mdhd');
      if (mdhd) {
        const ver = data[mdhd.dataOffset];
        timescale = view.getUint32(mdhd.dataOffset + (ver === 0 ? 12 : 20));
      } else {
        const mvhd = findBoxDeep(moov, 'mvhd');
        if (mvhd) {
          const ver = data[mvhd.dataOffset];
          timescale = view.getUint32(mvhd.dataOffset + (ver === 0 ? 12 : 20));
        }
      }
    }
  }

  // moof + mdat ペアを順に処理
  let offset = 0;
  while (offset < data.byteLength - 8) {
    const boxSize = view.getUint32(offset);
    const boxType = readBoxType(data, offset);
    if (boxSize < 8 || offset + boxSize > data.byteLength) break;

    if (boxType === 'moof') {
      const moofOffset = offset;
      const moofSamples = parseMoof(data, view, offset, boxSize);

      // 対応する mdat を探す (通常は moof の直後だが、間に他の box がある場合も考慮)
      const mdatBox = boxes.find(b => b.type === 'mdat' && b.offset >= offset + boxSize);

      if (mdatBox) {
        const mdatDataOffset = mdatBox.offset + 8;

        let sampleDataOffset = 0;
        if (moofSamples.dataOffset !== -1) {
          sampleDataOffset = moofOffset + moofSamples.dataOffset;
        } else {
          sampleDataOffset = mdatDataOffset;
        }

        let currentTime = moofSamples.baseDecodeTime;
        for (const sample of moofSamples.samples) {
          const pts = currentTime + (/** @type {any} */ (sample).compositionTimeOffset || 0);
          const timestampUs = Math.round((pts / timescale) * 1_000_000);
          const durationUs = Math.round((sample.duration / timescale) * 1_000_000);

          if (sampleDataOffset + sample.size <= data.byteLength) {
            chunks.push({
              data: data.slice(sampleDataOffset, sampleDataOffset + sample.size).buffer,
              timestamp: timestampUs,
              duration: durationUs,
              isKeyframe: sample.isKeyframe,
            });
          }

          sampleDataOffset += sample.size;
          currentTime += sample.duration;
        }
      }
    }

    offset += boxSize;
  }

  console.log(`[NicoCommentDL] Extracted ${chunks.length} video chunks from fMP4 (timescale=${timescale})`);
  return chunks;
}

/**
 * moof box を解析してサンプル情報を取得
 * @param {Uint8Array} data
 * @param {DataView} view
 * @param {number} moofOffset
 * @param {number} moofSize
 * @returns {{ baseDecodeTime: number, dataOffset: number, samples: Array<{ size: number, duration: number, isKeyframe: boolean }> }}
 */
function parseMoof(data, view, moofOffset, moofSize) {
  let baseDecodeTime = 0;
  let defaultSampleDuration = 0;
  let defaultSampleSize = 0;
  let defaultSampleFlags = 0;
  let dataOffset = -1;
  const samples = [];

  const moofEnd = moofOffset + moofSize;

  // traf を探す（moof > traf）
  let pos = moofOffset + 8;
  while (pos < moofEnd - 8) {
    const innerSize = view.getUint32(pos);
    const innerType = readBoxType(data, pos);
    if (innerSize < 8 || pos + innerSize > moofEnd) break;

    if (innerType === 'traf') {
      const trafEnd = pos + innerSize;
      let trafPos = pos + 8;

      while (trafPos < trafEnd - 8) {
        const subSize = view.getUint32(trafPos);
        const subType = readBoxType(data, trafPos);
        if (subSize < 8 || trafPos + subSize > trafEnd) break;

        if (subType === 'tfhd') {
          const flags = (data[trafPos + 9] << 16) | (data[trafPos + 10] << 8) | data[trafPos + 11];
          let p = trafPos + 12 + 4; // version+flags + track_id
          if (flags & 0x000001) p += 8; // base-data-offset
          if (flags & 0x000002) p += 4; // sample-description-index
          if (flags & 0x000008) { defaultSampleDuration = view.getUint32(p); p += 4; }
          if (flags & 0x000010) { defaultSampleSize = view.getUint32(p); p += 4; }
          if (flags & 0x000020) { defaultSampleFlags = view.getUint32(p); }
        } else if (subType === 'tfdt') {
          const ver = data[trafPos + 8];
          if (ver === 0) {
            baseDecodeTime = view.getUint32(trafPos + 12);
          } else {
            baseDecodeTime = Number(view.getBigUint64(trafPos + 12));
          }
        } else if (subType === 'trun') {
          const flags = (data[trafPos + 9] << 16) | (data[trafPos + 10] << 8) | data[trafPos + 11];
          const sampleCount = view.getUint32(trafPos + 12);
          let p = trafPos + 16;

          if (flags & 0x000001) {
            dataOffset = view.getInt32(p); // signed!
            p += 4;
          }

          let firstSampleFlags = -1;
          if (flags & 0x000004) {
            firstSampleFlags = view.getUint32(p);
            p += 4;
          }

          for (let s = 0; s < sampleCount; s++) {
            let duration = defaultSampleDuration;
            let size = defaultSampleSize;
            let sampleFlags = (s === 0 && firstSampleFlags !== -1) ? firstSampleFlags : defaultSampleFlags;

            if (flags & 0x000100) { duration = view.getUint32(p); p += 4; }
            if (flags & 0x000200) { size = view.getUint32(p); p += 4; }
            if (flags & 0x000400) { sampleFlags = view.getUint32(p); p += 4; }
            let compositionTimeOffset = 0;
            if (flags & 0x000800) {
              // version 0: unsigned, version 1: signed
              const trunVersion = data[trafPos + 8];
              compositionTimeOffset = trunVersion === 0 ? view.getUint32(p) : view.getInt32(p);
              p += 4;
            }

            // sample_depends_on == 2 means non-keyframe, sample_is_non_sync_sample flag
            const dependsOn = (sampleFlags >> 24) & 0x03;
            const isNonSync = (sampleFlags >> 16) & 0x01;
            // CMAF: 各セグメントの最初のサンプルは必ず keyframe (SAP type 1/2)
            const isKeyframe = s === 0 || (dependsOn !== 2 && isNonSync === 0);

            samples.push({ size, duration, isKeyframe, compositionTimeOffset });
          }
        }

        trafPos += subSize;
      }
    }

    pos += innerSize;
  }

  return { baseDecodeTime, dataOffset, samples };
}

/**
 * Box type を文字列として読み取る
 */
function readBoxType(data, offset) {
  return String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
}

/**
 * Box 構造をパース
 * @param {Uint8Array} data
 * @param {number} start
 * @param {number} end
 * @returns {Array<{ type: string, offset: number, size: number, dataOffset: number, children?: any[] }>}
 */
function parseBoxes(data, start, end) {
  const boxes = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = start;

  const containerTypes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

  while (offset < end - 8) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > end) break;

    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    const box = {
      type,
      offset,
      size,
      dataOffset: offset + 8,
      children: /** @type {any[] | undefined} */ (undefined),
    };

    if (containerTypes.has(type)) {
      box.children = parseBoxes(data, offset + 8, offset + size);
    } else if (type === 'stsd') {
      box.children = parseBoxes(data, offset + 16, offset + size); // skip version(1), flags(3), count(4)
    } else if (type === 'avc1' || type === 'hev1') {
      box.children = parseBoxes(data, offset + 86, offset + size); // skip 78 bytes header
    } else if (type === 'mp4a') {
      box.children = parseBoxes(data, offset + 36, offset + size); // skip 28 bytes header
    }

    boxes.push(box);
    offset += size;
  }

  return boxes;
}

/**
 * @param {Array<any>} boxes
 * @param {string} type
 */
function findBox(boxes, type) {
  return boxes.find(b => b.type === type) || null;
}

/**
 * @param {any} parentBox
 * @param {string} type
 * @returns {any}
 */
function findBoxDeep(parentBox, type) {
  if (parentBox.type === type) return parentBox;
  if (!parentBox.children) return null;
  for (const child of parentBox.children) {
    const found = findBoxDeep(child, type);
    if (found) return found;
  }
  return null;
}

/**
 * @param {any[]} boxes
 * @param {string} type
 * @returns {any}
 */
function findBoxDeepFromMany(boxes, type) {
  for (const box of boxes) {
    const found = findBoxDeep(box, type);
    if (found) return found;
  }
  return null;
}

/**
 * @param {Uint8Array} _data
 * @returns {Array<any>}
 */
function parseSampleTable(_stbl, _data) {
  return [];
}

/**
 * fMP4 バイナリから moof box を抽出するヘルパー
 * @param {Uint8Array} data
 * @returns {Array<any>}
 */
export function extractMoofMdat(data) {
  const results = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset < data.byteLength - 8) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > data.byteLength) break;
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    if (type === 'moof') results.push({ type, offset, size });
    offset += size;
  }
  return results;
}
