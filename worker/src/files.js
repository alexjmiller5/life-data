// File grants and canonical key checks happen before this storage boundary.
const reply = (body,status=200) => Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const hex = buffer => [...new Uint8Array(buffer)].map(n=>n.toString(16).padStart(2,'0')).join('');
const checksum = object => object.checksums?.sha256 ? hex(object.checksums.sha256) : null;

export async function putFile(request,archive,key) {
  const condition=request.headers.get('If-None-Match');
  const digest=request.headers.get('X-Content-SHA256');
  if ((condition!==null && condition!=='*')
    || ['If-Match','If-Modified-Since','If-Unmodified-Since','If-Range'].some(name=>request.headers.has(name))) {
    return reply({error:'unsupported_file_condition'},400);
  }
  if ((condition==='*' && !digest) || (digest!==null && !/^[0-9a-f]{64}$/.test(digest))) {
    return reply({error:'invalid_checksum'},400);
  }
  const options={httpMetadata:{contentType:request.headers.get('Content-Type') || 'application/octet-stream'}};
  if (condition==='*') options.onlyIf={etagDoesNotMatch:'*'};
  // R2 verifies the streamed body before committing. Do not trust caller-supplied
  // custom metadata or buffer an entire archive in the Worker's heap.
  if (digest) options.sha256=Uint8Array.from(digest.match(/../g),pair=>parseInt(pair,16)).buffer;
  try {
    const object=await archive.put(key,request.body,options);
    if (!object) return reply({error:'file_exists'},412);
    return reply({key,mime:object.httpMetadata?.contentType || options.httpMetadata.contentType,
      bytes:object.size,sha256:checksum(object),etag:object.httpEtag},201);
  } catch(error) {
    const code=/\((\d+)\)\s*$/.exec(String(error))?.[1];
    if (code==='10037') return reply({error:'checksum_mismatch'},400);
    if (code==='10031') return reply({error:'file_exists'},412);
    return reply({error:'file_upload_failed'},502);
  }
}

export function fileHeaders(object) {
  const headers=new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control','private, no-store, no-transform');
  headers.set('Accept-Ranges','bytes');
  headers.set('Content-Length',String(object.size));
  // MIME and filenames are untrusted. Applying these to every object also
  // protects SVG/XML or HTML disguised as another type on the authenticated host.
  headers.set('Content-Disposition','attachment');
  headers.set('X-Content-Type-Options','nosniff');
  headers.set('Content-Security-Policy',"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  if (object.httpEtag) headers.set('ETag',object.httpEtag);
  const sha256=checksum(object);
  if (sha256) headers.set('X-Content-SHA256',sha256);
  return headers;
}
