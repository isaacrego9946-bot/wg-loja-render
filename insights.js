module.exports=function(app,db,adm){
 const ready=db.query(`create table if not exists visitor_events(id bigserial primary key,session_id text not null,kind text not null,page text,product_id int,cart jsonb,created_at timestamptz default now());create index if not exists visitor_events_time on visitor_events(created_at);create index if not exists visitor_events_session on visitor_events(session_id,created_at);create table if not exists admin_audit(id bigserial primary key,actor text not null,action text not null,resource text not null,created_at timestamptz default now());`);
 const wrap=f=>async(q,r,n)=>{try{await ready;await f(q,r,n)}catch(e){console.error('insights',e.message);r.status(503).json({erro:'Relatórios temporariamente indisponíveis.'})}};
 let cleanup=0;const rates=new Map();
 app.post('/api/visits',wrap(async(q,r)=>{
  const{session,kind,page,product,cart}=q.body||{};
  if(!/^[a-f0-9-]{36}$/i.test(session||'')||!['page','heartbeat','product','cart','purchase'].includes(kind)||!['/','/loja.html','/pagina.html'].includes(page))return r.status(400).json({erro:'Evento inválido'});
  const now=Date.now(),rate=rates.get(session);if(rate&&rate.until>now&&rate.count>=120)return r.sendStatus(429);rates.set(session,{until:rate&&rate.until>now?rate.until:now+60000,count:rate&&rate.until>now?rate.count+1:1});if(rates.size>5000)for(const[k,v]of rates)if(v.until<now)rates.delete(k);
  if(cart!==undefined&&(!Array.isArray(cart)||cart.length>100||cart.some(i=>!Number.isSafeInteger(i.variant_id)||i.variant_id<1||!Number.isSafeInteger(i.qty)||i.qty<1||i.qty>999)))return r.status(400).json({erro:'Carrinho inválido'});
  await db.query('insert into visitor_events(session_id,kind,page,product_id,cart) values($1,$2,$3,$4,$5)',[session,kind,page,Number.isSafeInteger(product)&&product>0?product:null,cart===undefined?null:JSON.stringify(cart)]);
  if(now-cleanup>3600000){cleanup=now;await db.query("delete from visitor_events where created_at<now()-interval '30 days'");await db.query("delete from admin_audit where created_at<now()-interval '180 days'")}
  r.sendStatus(204);
 }));
 app.delete('/api/visits/:session',wrap(async(q,r)=>{if(!/^[a-f0-9-]{36}$/i.test(q.params.session))return r.sendStatus(400);await db.query('delete from visitor_events where session_id=$1',[q.params.session]);r.sendStatus(204)}));
 app.use('/api/admin',(q,r,n)=>{r.once('finish',()=>{if(r.statusCode<300&&['POST','PATCH','DELETE'].includes(q.method)&&q.path!='/login')ready.then(()=>db.query('insert into admin_audit(actor,action,resource) values($1,$2,$3)',['administrador principal',q.method,q.originalUrl.split('?')[0]])).catch(e=>console.error('audit',e.message))});n()});
 app.get('/api/admin/insights',adm,wrap(async(q,r)=>{
  const days=[1,7,30].includes(+q.query.days)?+q.query.days:7;
  const since=new Date(Date.now()-days*86400000).toISOString(),previous=new Date(Date.now()-days*2*86400000).toISOString();
  const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
  const visitors=await rows("select count(distinct session_id)::int visitors,count(*) filter(where kind='page')::int views,count(distinct session_id) filter(where kind='purchase')::int buyers from visitor_events where created_at>=$1",[since]);
  const online=await rows("select count(distinct session_id)::int n from visitor_events where created_at>now()-interval '90 seconds'");
  const pages=await rows("select page,count(*)::int views from visitor_events where kind='page' and created_at>=$1 group by page order by views desc",[since]);
  const products=await rows("select p.id,p.name,count(e.id)::int views from products p left join visitor_events e on e.product_id=p.id and e.kind='product' and e.created_at>=$1 group by p.id order by views desc",[since]);
  const low=await rows('select p.name,v.size,v.color,v.stock from variants v join products p on p.id=v.product_id where v.stock<=3 order by v.stock,p.name');
  const abandoned=await rows("select session_id,cart,created_at from(select distinct on(session_id) session_id,cart,created_at from visitor_events where kind='cart' and created_at>=$1 order by session_id,created_at desc)x where jsonb_array_length(cart)>0 and created_at<now()-interval '30 minutes' and not exists(select 1 from visitor_events e where e.session_id=x.session_id and e.kind='purchase' and e.created_at>=x.created_at) order by created_at desc limit 100",[since]);
  const revenue=await rows("select (created_at at time zone 'America/Sao_Paulo')::date::text sales_day,count(*)::int orders,coalesce(sum(total) filter(where status in('Pago','Separando','Enviado','Entregue')),0)::float revenue from orders where created_at>=$1 group by sales_day order by sales_day",[since]);
  const previousSales=await rows("select coalesce(sum(total),0)::float revenue from orders where created_at>=$1 and created_at<$2 and status in('Pago','Separando','Enviado','Entregue')",[previous,since]);
  const pending=await rows("select id,status,created_at from orders where status='Novo' or(status not in('Entregue','Cancelado') and created_at<now()-interval '24 hours') order by created_at limit 100");
  const unsold=await rows("select p.id,p.name from products p where not exists(select 1 from orders o cross join lateral jsonb_array_elements(o.items) i where (i->>'product_id'=p.id::text or(i->>'product_id' is null and i->>'name'=p.name)) and o.status!='Cancelado') order by p.name");
  const traffic=await rows("select (created_at at time zone 'America/Sao_Paulo')::date::text access_day,count(distinct session_id)::int sessions,count(*) filter(where kind='page')::int views from visitor_events where created_at>=$1 group by access_day order by access_day",[since]);
  const activity=await rows('select session_id,kind,page,product_id,created_at from visitor_events where created_at>=$1 order by id desc limit 200',[since]);
  const variants=await rows('select v.id,p.name,v.size,v.color from variants v join products p on p.id=v.product_id');
  const audit=await rows('select actor,action,resource,created_at from admin_audit order by id desc limit 100');
  r.json({days,traffic,activity,variants,visitors:visitors[0],online:online[0].n,pages,products,low,abandoned,revenue:revenue.map(x=>({...x,day:x.sales_day})),previousRevenue:previousSales[0].revenue,pending,unsold,audit,privacy:'Somente visitantes com consentimento. Dados anônimos por sessão, retidos por 30 dias; sem IP, nome, telefone ou ligação ao cadastro.'});
 }));
 app.get('/api/health',async(q,r)=>{try{await db.query('select 1');r.json({status:'ok',database:'ok'})}catch{r.status(503).json({status:'unavailable'})}});
 const maintenance=setInterval(()=>ready.then(()=>db.query("delete from visitor_events where created_at<now()-interval '30 days'")).then(()=>db.query("delete from admin_audit where created_at<now()-interval '180 days'")).catch(e=>console.error('retention',e.message)),3600000);maintenance.unref();
 return ready;
};
