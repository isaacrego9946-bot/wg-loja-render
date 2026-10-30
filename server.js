const express=require('express'),{Pool}=require('pg'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken');
const app=express();app.set('trust proxy',1);
const ORIGINS=(process.env.CORS_ORIGIN||'https://trulusiolotreck.github.io').split(',');
app.use((q,r,n)=>{const o=q.headers.origin;if(o&&ORIGINS.includes(o))r.set({'Access-Control-Allow-Origin':o,'Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS',Vary:'Origin'});if(q.method=='OPTIONS')return r.sendStatus(204);n()});
const tries={};app.use(['/api/admin/login','/api/login'],(q,r,n)=>{if(q.method!='POST')return n();const t=Date.now(),a=(tries[q.ip]=(tries[q.ip]||[]).filter(x=>t-x<9e5));if(a.length>=10)return r.status(429).json({erro:'Muitas tentativas. Aguarde 15 minutos.'});a.push(t);n()});
app.use(express.json({limit:'5mb'}));app.use(express.static('public'));app.get('/health',(q,r)=>r.send('ok'));
const db=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
if(!process.env.JWT_SECRET||!process.env.ADMIN_PASSWORD||process.env.JWT_SECRET.length<24){console.error('Defina JWT_SECRET (24+ caracteres) e ADMIN_PASSWORD no ambiente.');process.exit(1)}
const SECRET=process.env.JWT_SECRET,ADMIN=process.env.ADMIN_PASSWORD;
const WA=process.env.WHATSAPP||'5516999999999';
db.on('error',e=>console.error('db',e.message));process.on('unhandledRejection',e=>console.error('erro',e&&e.message));
(async()=>{await db.query(`
create table if not exists products(id serial primary key,name text,category text,price numeric(10,2),image text,description text);
create table if not exists variants(id serial primary key,product_id int references products(id) on delete cascade,size text,color text,stock int default 0);
create table if not exists users(id serial primary key,name text,email text unique,phone text,pass text);
create table if not exists orders(id serial primary key,user_id int,customer jsonb,items jsonb,shipping numeric(10,2),total numeric(10,2),payment text,status text default 'Novo',created_at timestamptz default now());`).catch(e=>console.error('Banco indisponível:',e.message));})();
const auth=(req,res,next)=>{try{req.u=jwt.verify((req.headers.authorization||'').slice(7),SECRET);next()}catch{res.status(401).json({erro:'Faça login'})}};
const adm=(req,res,next)=>{try{if(jwt.verify((req.headers.authorization||'').slice(7),SECRET).admin)return next()}catch{}res.status(401).json({erro:'Acesso negado'})};
const frete=cep=>String(cep).replace(/\D/g,'').startsWith('14')?{entrega:15,retirada:0}:{entrega:30,retirada:0};
app.get('/api/config',(q,r)=>r.json({whatsapp:WA,pix:process.env.PIX_KEY||''}));
app.get('/api/frete/:cep',(q,r)=>r.json(frete(q.params.cep)));
const W=f=>(q,r,n)=>f(q,r,n).catch(e=>r.status(500).json({erro:'Erro no servidor: '+e.message}));
app.get('/api/products',W(async(q,r)=>{const{q:s='',cat='',size='',color=''}=q.query;
 const p=await db.query(`select p.*,coalesce(json_agg(json_build_object('id',v.id,'size',v.size,'color',v.color,'stock',v.stock)) filter(where v.id is not null),'[]') variants from products p left join variants v on v.product_id=p.id where p.name ilike $1 and ($2='' or p.category=$2) group by p.id order by p.id desc`,[`%${s}%`,cat]);
 r.json(p.rows.filter(x=>(!size&&!color)||x.variants.some(v=>(!size||v.size==size)&&(!color||v.color==color))))}));
app.post('/api/register',(q,r)=>r.status(403).json({erro:'Cadastro indisponível'}));
app.post('/api/login',W(async(q,r)=>{
 const name=process.env.STORE_LOGIN_NAME;
 if(!name||q.body.name!==name||q.body.password!==ADMIN)return r.status(401).json({erro:'Nome ou senha inválidos'});
 const u=(await db.query("insert into users(name,email,pass) values($1,$2,$3) on conflict(email) do update set name=excluded.name returning id,name",[name,'store-access@wg.invalid',await bcrypt.hash(ADMIN,10)])).rows[0];
 r.json({token:jwt.sign({id:u.id,name:u.name},SECRET,{expiresIn:'30d'}),name:u.name})
}));
app.post('/api/orders',auth,W(async(q,r)=>{const{items,address,cep,delivery,payment,phone}=q.body;
 if(!Array.isArray(items)||!items.length||items.length>100||items.some(i=>!i||!Number.isSafeInteger(i.variant_id)||i.variant_id<=0||!Number.isSafeInteger(i.qty)||i.qty<=0))return r.status(400).json({erro:'Informe itens e quantidades inteiras maiores que zero.'});
 const c=await db.connect();
 try{await c.query('begin');let sub=0;const list=[];
 for(const i of [...items].sort((a,b)=>a.variant_id-b.variant_id)){const v=(await c.query('select v.*,p.name,p.price from variants v join products p on p.id=v.product_id where v.id=$1 for update',[i.variant_id])).rows[0];
  if(!v||v.stock<i.qty)throw Error(v?'Estoque insuficiente: '+v.name+' ('+v.size+'/'+v.color+'). Disponível: '+v.stock:'Produto indisponível.');
  await c.query('update variants set stock=stock-$1 where id=$2',[i.qty,v.id]);sub+=v.price*i.qty;list.push({name:v.name,size:v.size,color:v.color,qty:i.qty,price:+v.price})}
 const ship=delivery=='retirada'?0:frete(cep).entrega,tot=sub+ship;
 const o=(await c.query('insert into orders(user_id,customer,items,shipping,total,payment) values($1,$2,$3,$4,$5,$6) returning id',[q.u.id,{name:q.u.name,phone,address,cep,delivery},JSON.stringify(list),ship,tot,payment])).rows[0];
 await c.query('commit');r.json({id:o.id,total:tot})}catch(e){await c.query('rollback');r.status(400).json({erro:e.message})}finally{c.release()}}));
app.get('/api/orders/mine',auth,async(q,r)=>r.json((await db.query('select id,items,total,status,created_at from orders where user_id=$1 order by id desc',[q.u.id])).rows));
app.post('/api/admin/login',(q,r)=>q.body.password===ADMIN?r.json({token:jwt.sign({admin:1},SECRET,{expiresIn:'12h'})}):r.status(401).json({erro:'Senha incorreta'}));
app.post('/api/admin/products',adm,W(async(q,r)=>{
 const{id,name,category,price,image,description,variants=[]}=q.body;
 if(typeof name!=='string'||!name.trim()||price===''||price==null||!Number.isFinite(+price)||+price<0||!Array.isArray(variants)||variants.some(v=>!v||typeof v.size!=='string'||!v.size.trim()||typeof v.color!=='string'||!v.color.trim()||!Number.isSafeInteger(v.stock)||v.stock<0))return r.status(400).json({erro:'Informe nome, preço válido e estoque inteiro maior ou igual a zero.'});
 const keys=variants.map(v=>JSON.stringify([v.size.trim(),v.color.trim()]));
 if(new Set(keys).size!==keys.length)return r.status(400).json({erro:'Não repita a mesma combinação de tamanho e cor.'});
 const c=await db.connect();
 try{await c.query('begin');let pid=id;
 if(id){const updated=await c.query('update products set name=$1,category=$2,price=$3,image=$4,description=$5 where id=$6 returning id',[name.trim(),category,price,image,description,id]);if(!updated.rows.length)throw Error('Produto não encontrado');}
 else pid=(await c.query('insert into products(name,category,price,image,description) values($1,$2,$3,$4,$5) returning id',[name.trim(),category,price,image,description])).rows[0].id;
 const previous=(await c.query('select * from variants where product_id=$1 for update',[pid])).rows,keep=[];
 for(const v of variants){const size=v.size.trim(),color=v.color.trim(),old=previous.find(x=>x.size===size&&x.color===color);
 if(old){await c.query('update variants set stock=$1 where id=$2',[v.stock,old.id]);keep.push(old.id)}
 else keep.push((await c.query('insert into variants(product_id,size,color,stock) values($1,$2,$3,$4) returning id',[pid,size,color,v.stock])).rows[0].id);}
 await c.query('delete from variants where product_id=$1 and not(id=any($2::int[]))',[pid,keep]);await c.query('commit');r.json({id:pid});
 }catch(e){await c.query('rollback');r.status(400).json({erro:e.message})}finally{c.release()}
}));
app.delete('/api/admin/products/:id',adm,async(q,r)=>{await db.query('delete from products where id=$1',[q.params.id]);r.json({ok:1})});
app.get('/api/admin/orders',adm,async(q,r)=>r.json((await db.query('select * from orders order by id desc limit 200')).rows));
app.patch('/api/admin/orders/:id',adm,async(q,r)=>{await db.query('update orders set status=$1 where id=$2',[q.body.status,q.params.id]);r.json({ok:1})});
app.listen(process.env.PORT||3000);
