import { Database } from '../db/database';
import { config } from '../config';
import { escapeHtml,signContact } from './personalization';
export async function trackHtml(db:Database,id:string,html:string){
 const pattern=/href\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi;const matches=[...html.matchAll(pattern)];
 for(const match of matches){
  const target=match[2].replace(/&amp;/g,'&');if(target.startsWith(config.PUBLIC_API_URL+'/unsubscribe/'))continue;
  let url:URL;try{url=new URL(target);}catch{continue;}if(url.username||url.password)continue;
  const link=(await db.query('INSERT INTO tracking_links(message_id,url) VALUES($1,$2) ON CONFLICT(message_id,url) DO UPDATE SET url=EXCLUDED.url RETURNING id',[id,url.href])).rows[0];
  const destination=`${config.PUBLIC_API_URL}/track/click/${link.id}?token=${signContact(`click:${link.id}`,config.UNSUBSCRIBE_SECRET)}`;
  html=html.replace(match[0],`href="${escapeHtml(destination)}"`);
 }
 const pixel=`<img src="${escapeHtml(`${config.PUBLIC_API_URL}/track/open/${id}?token=${signContact(`open:${id}`,config.UNSUBSCRIBE_SECRET)}`)}" width="1" height="1" alt="" style="display:block;border:0">`;
 return /<\/body>/i.test(html)?html.replace(/<\/body>/i,pixel+'</body>'):html+pixel;
}
