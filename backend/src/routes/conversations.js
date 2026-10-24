const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const authenticateToken = require("../middleware/auth");
const { createNotification } = require("../notifications");
const { currentUser } = require("../authorityAccess");

const router = express.Router();
router.use(authenticateToken);

function parseClaimId(value) {
  return /^[1-9]\d*$/.test(String(value || "")) ? String(value) : null;
}

async function loadContext(client, claimId, userId, lock = false) {
  const result = await client.query(
    `SELECT c.claim_id, c.claim_status, c.claimant_user_id,
            conv.conversation_id, conv.conversation_status,
            f.user_id AS finder_id, f.recovery_mode, f.authority_id,
            i.title AS item_title,
            EXISTS (SELECT 1 FROM custody_transfer_requests ctr
                    WHERE ctr.report_id=f.report_id AND ctr.custody_status='RECEIVED') AS custody_received
     FROM claim_requests c
     JOIN match_records m ON m.match_id=c.match_id
     JOIN reports f ON f.report_id=m.found_report_id
     JOIN items i ON i.item_id=f.item_id
     LEFT JOIN conversations conv ON conv.claim_id=c.claim_id
     WHERE c.claim_id=$1${lock ? " FOR UPDATE OF c, m, f" : ""}`,
    [claimId]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (!row.conversation_id || row.conversation_status !== "OPEN" ||
      !["SUBMITTED", "IN_REVIEW", "APPROVED"].includes(row.claim_status)) return null;
  const user = await currentUser(client, userId);
  if (!user || user.account_status !== "ACTIVE") return null;
  if (Number(row.claimant_user_id) === Number(userId)) return { row, side: "CLAIMANT" };
  if (row.recovery_mode === "DIRECT" && Number(row.finder_id) === Number(userId)) {
    return { row, side: "FINDER" };
  }
  if (row.recovery_mode === "AUTHORITY" && row.custody_received && row.authority_id) {
    const membership = await client.query(
      `SELECT am.membership_id
       FROM authority_memberships am
       JOIN authority_destinations ad ON ad.authority_id=am.authority_id
       JOIN users u ON u.user_id=am.user_id
       WHERE am.user_id=$1 AND am.authority_id=$2 AND am.membership_status='ACTIVE'
         AND ad.verification_status='VERIFIED' AND ad.destination_status='ACTIVE'
         AND u.account_status='ACTIVE'
       FOR SHARE OF am, ad, u`,
      [userId, row.authority_id]
    );
    if (membership.rowCount) return { row, side: "AUTHORITY" };
  }
  return null;
}

router.get("/claims/:claimId", async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  const beforeId = req.query.beforeMessageId === undefined ? null : parseClaimId(req.query.beforeMessageId);
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!claimId || (req.query.beforeMessageId !== undefined && !beforeId) || !Number.isInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ error: "Invalid conversation history request" });
  try {
    const context = await loadContext(pool, claimId, req.user.userId);
    if (!context) return res.status(403).json({ error: "Conversation is not available to this account" });
    const messages = await pool.query(
      `SELECT m.message_id, m.message_body, m.sent_at, u.name AS sender_name, m.sender_user_id,
              EXISTS (SELECT 1 FROM conversation_read_states rs
                      WHERE rs.conversation_id=m.conversation_id AND rs.user_id<>m.sender_user_id
                        AND rs.last_read_message_id>=m.message_id) AS read_by_other
       FROM conversations conv
       JOIN messages m ON m.conversation_id=conv.conversation_id
       JOIN users u ON u.user_id=m.sender_user_id
       WHERE conv.claim_id=$1 AND ($2::bigint IS NULL OR m.message_id<$2)
       ORDER BY m.message_id DESC LIMIT $3`,
      [claimId, beforeId, limit]
    );
    messages.rows.reverse();
    const proofRequests = await pool.query(
      `SELECT r.proof_request_id, r.proof_category, r.request_text, r.request_status,
              r.created_at, r.updated_at, r.requester_user_id, r.recipient_user_id,
              COALESCE(json_agg(json_build_object(
                'attachmentId', a.proof_attachment_id, 'contentType', a.content_type,
                'byteSize', a.byte_size, 'uploadedAt', a.uploaded_at, 'note', a.submission_note
              ) ORDER BY a.uploaded_at) FILTER (WHERE a.proof_attachment_id IS NOT NULL), '[]'::json) AS attachments
       FROM conversations v JOIN conversation_proof_requests r USING (conversation_id)
       LEFT JOIN conversation_proof_attachments a USING (proof_request_id)
       WHERE v.claim_id=$1 GROUP BY r.proof_request_id ORDER BY r.created_at`,
      [claimId]
    );
    return res.json({
      claimId: Number(claimId),
      conversationStatus: context.row.conversation_status,
      participantType: context.side,
      itemTitle: context.row.item_title,
      recoveryMode: context.row.recovery_mode,
      canRequestProof: context.side === "FINDER" || context.side === "AUTHORITY",
      hasMore: messages.rowCount === limit,
      proofRequests: proofRequests.rows.map((request) => ({
        requestId: Number(request.proof_request_id), category: request.proof_category,
        text: request.request_text, status: request.request_status,
        createdAt: request.created_at, updatedAt: request.updated_at,
        isRequester: Number(request.requester_user_id) === Number(req.user.userId),
        canUpload: context.side === "CLAIMANT" && Number(request.recipient_user_id) === Number(req.user.userId) && ["OPEN", "NEEDS_MORE_INFORMATION"].includes(request.request_status),
        attachments: request.attachments.map((attachment) => ({
          attachmentId: Number(attachment.attachmentId), contentType: attachment.contentType,
          byteSize: Number(attachment.byteSize), uploadedAt: attachment.uploadedAt, note: attachment.note,
        })),
      })),
      messages: messages.rows.map((message) => ({
        messageId: Number(message.message_id),
        senderName: message.sender_name,
        sentAt: message.sent_at,
        body: message.message_body,
        isYou: Number(message.sender_user_id) === Number(req.user.userId),
        readByOther: message.read_by_other,
      })),
    });
  } catch (error) {
    console.error("Read claim conversation failed:", error.message);
    return res.status(500).json({ error: "Unable to load conversation" });
  }
});

router.post("/claims/:claimId", async (req, res) => {
  const claimId = parseClaimId(req.params.claimId);
  const body = req.body?.message;
  const clientMessageId = req.body?.clientMessageId;
  if (!claimId) return res.status(400).json({ error: "Invalid claim ID" });
  if (typeof body !== "string" || !body.trim() || body.trim().length > 2000) {
    return res.status(400).json({ error: "Message must contain 1 to 2000 characters" });
  }
  if (clientMessageId !== undefined && (typeof clientMessageId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientMessageId))) {
    return res.status(400).json({ error: "Invalid client message ID" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const context = await loadContext(client, claimId, req.user.userId, true);
    if (!context) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Conversation is not available to this account" });
    }
    const locked = await client.query(
      "SELECT conversation_id, conversation_status FROM conversations WHERE claim_id=$1 FOR UPDATE",
      [claimId]
    );
    if (!locked.rowCount || locked.rows[0].conversation_status !== "OPEN") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Conversation is closed" });
    }
    if (clientMessageId) {
      const existing = await client.query(
        "SELECT message_id, sent_at FROM messages WHERE conversation_id=$1 AND sender_user_id=$2 AND client_message_id=$3",
        [locked.rows[0].conversation_id, req.user.userId, clientMessageId]
      );
      if (existing.rowCount) {
        await client.query("COMMIT");
        return res.status(200).json({ message: { messageId: Number(existing.rows[0].message_id), sentAt: existing.rows[0].sent_at }, duplicate: true });
      }
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext('chat-rate:' || $1::text))", [req.user.userId]);
    const rate = await client.query(
      "SELECT COUNT(*)::int AS count FROM messages WHERE sender_user_id=$1 AND sent_at>NOW()-INTERVAL '1 minute'",
      [req.user.userId]
    );
    if (rate.rows[0].count >= 30) {
      await client.query("ROLLBACK");
      return res.status(429).json({ error: "Message rate limit reached; try again shortly" });
    }
    const inserted = await client.query(
      `INSERT INTO messages (conversation_id, sender_user_id, message_body, client_message_id)
       VALUES ($1,$2,$3,$4) RETURNING message_id, sent_at`,
      [locked.rows[0].conversation_id, req.user.userId, body.trim(), clientMessageId || null]
    );
    let recipients;
    if (context.side === "CLAIMANT") {
      if (context.row.recovery_mode === "AUTHORITY") {
        recipients = await client.query(
          `SELECT DISTINCT am.user_id FROM authority_memberships am
           JOIN authority_destinations ad ON ad.authority_id=am.authority_id
           JOIN users u ON u.user_id=am.user_id
           WHERE am.authority_id=$1 AND am.membership_status='ACTIVE'
             AND ad.verification_status='VERIFIED' AND ad.destination_status='ACTIVE'
             AND u.account_status='ACTIVE'`,
          [context.row.authority_id]
        );
      } else {
        recipients = { rows: [{ user_id: context.row.finder_id }] };
      }
    } else {
      recipients = { rows: [{ user_id: context.row.claimant_user_id }] };
    }
    for (const recipient of recipients.rows) {
      if (Number(recipient.user_id) !== Number(req.user.userId)) {
        await createNotification(client, recipient.user_id, "NEW_CLAIM_MESSAGE", "MESSAGE", inserted.rows[0].message_id);
      }
    }
    await client.query("COMMIT");
    return res.status(201).json({ message: { messageId: Number(inserted.rows[0].message_id), sentAt: inserted.rows[0].sent_at } });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* retain the original error */ }
    }
    console.error("Send claim conversation message failed:", error.message);
    return res.status(500).json({ error: "Unable to send message" });
  } finally {
    if (client) client.release();
  }
});

const fs12 = require("node:fs/promises");
const path12 = require("node:path");
const crypto12 = require("node:crypto");
const privateProofDir12 = path12.resolve(process.env.PRIVATE_PROOF_DIR || path12.join(__dirname, "../../private-proof-files"));
const proofCategories12 = new Set(["PURCHASE_RECEIPT","PRE_LOSS_PHOTO","DISTINGUISHING_MARK","PACKAGING_LABEL_SERIAL","OTHER"]);

router.get("/inbox", async (req,res) => {
  try {
    const q=await pool.query(`SELECT v.claim_id,v.conversation_id,v.created_at,c.claimant_user_id,f.recovery_mode,f.user_id finder_id,
      i.title,lm.message_body,lm.sent_at,COALESCE((SELECT COUNT(*) FROM messages x WHERE x.conversation_id=v.conversation_id AND x.sender_user_id<>$1
      AND x.message_id>COALESCE((SELECT last_read_message_id FROM conversation_read_states r WHERE r.conversation_id=v.conversation_id AND r.user_id=$1),0)),0)::int unread
      FROM conversations v JOIN claim_requests c USING(claim_id) JOIN match_records m USING(match_id)
      JOIN reports f ON f.report_id=m.found_report_id JOIN items i USING(item_id)
      LEFT JOIN LATERAL(SELECT message_body,sent_at FROM messages WHERE conversation_id=v.conversation_id ORDER BY message_id DESC LIMIT 1) lm ON TRUE
      WHERE v.conversation_status='OPEN' AND c.claim_status IN('SUBMITTED','IN_REVIEW','APPROVED')
      ORDER BY COALESCE(lm.sent_at,v.created_at) DESC LIMIT 100`,[req.user.userId]);
    const conversations=[];
    for(const x of q.rows){const c=await loadContext(pool,x.claim_id,req.user.userId);if(!c)continue;
      let counterpart=null;
      if(c.side==="CLAIMANT"&&c.row.recovery_mode==="AUTHORITY")counterpart="Assigned authority";
      else {const uid=c.side==="CLAIMANT"?c.row.finder_id:c.row.claimant_user_id;const n=await pool.query("SELECT name FROM users WHERE user_id=$1 AND account_status='ACTIVE'",[uid]);counterpart=n.rows[0]?.name||null;}
      conversations.push({claimId:+x.claim_id,itemTitle:x.title,participantType:c.side,counterpartName:counterpart,latestMessage:x.message_body||"",latestMessageAt:x.sent_at||x.created_at,unreadCount:x.unread});
    }
    res.json({conversations});
  }catch(e){console.error("List conversation inbox failed:",e.message);res.status(500).json({error:"Unable to load conversations"});}
});

router.get("/claims/:claimId/events", async(req,res)=>{
  const claimId=parseClaimId(req.params.claimId);if(!claimId)return res.status(400).json({error:"Invalid claim ID"});
  const streamToken=req.headers.authorization?.slice(7);
  try{
    const initial=await loadContext(pool,claimId,req.user.userId);if(!initial)return res.status(403).json({error:"Conversation is not available to this account"});
    res.set({"Content-Type":"text/event-stream","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});res.flushHeaders?.();
    res.write("event: ready\ndata: {}\n\n");let previous="";
    const timer=setInterval(async()=>{try{
      jwt.verify(streamToken,process.env.JWT_SECRET);
      const c=await loadContext(pool,claimId,req.user.userId);if(!c){res.write("event: revoked\ndata: {}\n\n");clearInterval(timer);return res.end();}
      const q=await pool.query("SELECT (SELECT COALESCE(MAX(message_id),0)::text FROM messages WHERE conversation_id=$1) msg,(SELECT COALESCE(MAX(updated_at),'epoch'::timestamptz) FROM conversation_proof_requests WHERE conversation_id=$1) proof",[c.row.conversation_id]);
      const key=q.rows[0].msg+":"+q.rows[0].proof.toISOString();
      if(key!==previous){previous=key;res.write(`event: changed\ndata: ${JSON.stringify({claimId:+claimId})}\n\n`);}else res.write(": keepalive\n\n");
    }catch{clearInterval(timer);res.end();}},1800);
    req.on("close",()=>clearInterval(timer));
  }catch(e){console.error("Conversation event stream failed:",e.message);if(!res.headersSent)res.status(500).json({error:"Unable to subscribe"});}
});

router.patch("/claims/:claimId/read",async(req,res)=>{
  const claimId=parseClaimId(req.params.claimId),msg=req.body?.lastReadMessageId===undefined?null:parseClaimId(req.body.lastReadMessageId);
  if(!claimId||(req.body?.lastReadMessageId!==undefined&&!msg))return res.status(400).json({error:"Invalid read receipt"});
  try{const c=await loadContext(pool,claimId,req.user.userId);if(!c)return res.status(403).json({error:"Conversation unavailable"});
    const q=await pool.query(`INSERT INTO conversation_read_states(conversation_id,user_id,last_read_message_id,read_at)
      SELECT $1,$2,$3,NOW() WHERE $3::bigint IS NULL OR EXISTS(SELECT 1 FROM messages WHERE message_id=$3 AND conversation_id=$1)
      ON CONFLICT(conversation_id,user_id) DO UPDATE SET last_read_message_id=CASE WHEN EXCLUDED.last_read_message_id IS NULL THEN conversation_read_states.last_read_message_id
      ELSE GREATEST(COALESCE(conversation_read_states.last_read_message_id,0),EXCLUDED.last_read_message_id) END,read_at=NOW() RETURNING read_at`,
      [c.row.conversation_id,req.user.userId,msg]);
    if(!q.rowCount)return res.status(400).json({error:"Message not in this conversation"});res.json({readAt:q.rows[0].read_at});
  }catch(e){console.error("Update chat read state failed:",e.message);res.status(500).json({error:"Unable to update read state"});}
});

router.post("/claims/:claimId/proof-requests",async(req,res)=>{
  const claimId=parseClaimId(req.params.claimId),{category,text}=req.body||{};
  if(!claimId||!proofCategories12.has(category)||typeof text!=="string"||!text.trim()||text.trim().length>500)return res.status(400).json({error:"Choose a valid proof category and request text"});
  let client;try{client=await pool.connect();await client.query("BEGIN");
    const c=await loadContext(client,claimId,req.user.userId,true);if(!c){await client.query("ROLLBACK");return res.status(403).json({error:"Conversation unavailable"});}
    if(!["FINDER","AUTHORITY"].includes(c.side)){await client.query("ROLLBACK");return res.status(403).json({error:"Only the finder or assigned authority may request proof"});}
    await client.query("SELECT pg_advisory_xact_lock(hashtext('proof-request-rate:' || $1::text))",[req.user.userId]);
    const rate=await client.query("SELECT COUNT(*)::int n FROM conversation_proof_requests WHERE requester_user_id=$1 AND created_at>NOW()-INTERVAL '1 hour'",[req.user.userId]);
    if(rate.rows[0].n>=10){await client.query("ROLLBACK");return res.status(429).json({error:"Proof request rate limit reached"});}
    const q=await client.query("INSERT INTO conversation_proof_requests(conversation_id,requester_user_id,recipient_user_id,proof_category,request_text) VALUES($1,$2,$3,$4,$5) RETURNING proof_request_id,proof_category,request_text,request_status,created_at",[c.row.conversation_id,req.user.userId,c.row.claimant_user_id,category,text.trim()]);
    await createNotification(client,c.row.claimant_user_id,"PROOF_REQUESTED","PROOF_REQUEST",q.rows[0].proof_request_id);
    await client.query("INSERT INTO audit_logs(actor_user_id,action_type,entity_type,entity_id,metadata) VALUES($1,'CHAT_PROOF_REQUESTED','PROOF_REQUEST',$2,'{}')",[req.user.userId,q.rows[0].proof_request_id]);
    await client.query("COMMIT");res.status(201).json({proofRequest:q.rows[0]});
  }catch(e){if(client)try{await client.query("ROLLBACK")}catch{}console.error("Create proof request failed:",e.message);res.status(500).json({error:"Unable to create proof request"});}finally{client?.release();}
});

router.patch("/proof-requests/:requestId",async(req,res)=>{
  const rid=parseClaimId(req.params.requestId),status=req.body?.status;
  if(!rid||!["ACCEPTED","NEEDS_MORE_INFORMATION","CANCELLED"].includes(status))return res.status(400).json({error:"Invalid proof status"});
  let client;try{client=await pool.connect();await client.query("BEGIN");
    const q=await client.query("SELECT r.*,v.claim_id FROM conversation_proof_requests r JOIN conversations v USING(conversation_id) WHERE proof_request_id=$1 FOR UPDATE OF r",[rid]);
    if(!q.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Proof request not found"});}
    const r=q.rows[0],c=await loadContext(client,r.claim_id,req.user.userId,true);
    if(!c||+r.requester_user_id!==+req.user.userId||!["FINDER","AUTHORITY"].includes(c.side)){await client.query("ROLLBACK");return res.status(403).json({error:"Only the authorized requester may review proof"});}
    const valid=status==="CANCELLED"?["OPEN","NEEDS_MORE_INFORMATION"].includes(r.request_status):r.request_status==="SUBMITTED";
    if(!valid){await client.query("ROLLBACK");return res.status(409).json({error:"Invalid proof status transition"});}
    await client.query("UPDATE conversation_proof_requests SET request_status=$2,updated_at=NOW() WHERE proof_request_id=$1",[rid,status]);
    const nt=status==="ACCEPTED"?"PROOF_ACCEPTED":status==="NEEDS_MORE_INFORMATION"?"PROOF_MORE_INFORMATION":"PROOF_REQUEST_CANCELLED";
    await createNotification(client,r.recipient_user_id,nt,"PROOF_REQUEST",rid);
    await client.query("INSERT INTO audit_logs(actor_user_id,action_type,entity_type,entity_id,metadata) VALUES($1,$2,'PROOF_REQUEST',$3,'{}')",[req.user.userId,"CHAT_PROOF_"+status,rid]);
    await client.query("COMMIT");res.json({proofRequestId:+rid,status});
  }catch(e){if(client)try{await client.query("ROLLBACK")}catch{}console.error("Review proof request failed:",e.message);res.status(500).json({error:"Unable to update proof request"});}finally{client?.release();}
});

router.put("/proof-requests/:requestId/attachments",express.raw({type:["application/pdf","image/jpeg","image/png","image/webp"],limit:Number(process.env.CHAT_PROOF_MAX_BYTES||8*1024*1024)}),async(req,res)=>{
  const rid=parseClaimId(req.params.requestId),b=req.body;
  let actual=null;if(Buffer.isBuffer(b)){if(b.subarray(0,5).toString()==="%PDF-")actual="application/pdf";else if(b[0]===255&&b[1]===216&&b[2]===255)actual="image/jpeg";else if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))actual="image/png";else if(b.subarray(0,4).toString()==="RIFF"&&b.subarray(8,12).toString()==="WEBP")actual="image/webp";}
  if(!rid||!Buffer.isBuffer(b)||!b.length||!actual||actual!==req.headers["content-type"])return res.status(400).json({error:"Unsupported, invalid, or empty proof file"});
  let client,filePath;try{client=await pool.connect();await client.query("BEGIN");
    const q=await client.query("SELECT r.*,v.claim_id FROM conversation_proof_requests r JOIN conversations v USING(conversation_id) WHERE proof_request_id=$1 FOR UPDATE OF r",[rid]);
    if(!q.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Proof request not found"});}
    const r=q.rows[0],c=await loadContext(client,r.claim_id,req.user.userId,true);
    if(!c||c.side!=="CLAIMANT"||+r.recipient_user_id!==+req.user.userId){await client.query("ROLLBACK");return res.status(403).json({error:"Only the intended claimant may upload proof"});}
    if(!["OPEN","NEEDS_MORE_INFORMATION"].includes(r.request_status)){await client.query("ROLLBACK");return res.status(409).json({error:"Proof request is not accepting uploads"});}
    await client.query("SELECT pg_advisory_xact_lock(hashtext('proof-upload-rate:' || $1::text))",[req.user.userId]);
    const rate=await client.query("SELECT COUNT(*)::int n FROM conversation_proof_attachments WHERE uploaded_by_user_id=$1 AND uploaded_at>NOW()-INTERVAL '1 hour'",[req.user.userId]);
    if(rate.rows[0].n>=20){await client.query("ROLLBACK");return res.status(429).json({error:"Proof upload rate limit reached"});}
    const previous=await client.query("SELECT 1 FROM conversation_proof_attachments WHERE proof_request_id=$1",[rid]);
    if(previous.rowCount&&r.request_status!=="NEEDS_MORE_INFORMATION"){await client.query("ROLLBACK");return res.status(409).json({error:"Proof already submitted"});}
    const key=crypto12.randomUUID();await fs12.mkdir(privateProofDir12,{recursive:true,mode:0o700});filePath=path12.join(privateProofDir12,key);await fs12.writeFile(filePath,b,{flag:"wx",mode:0o600});
    const note=String(req.headers["x-proof-note"]||"").slice(0,500)||null;
    const a=await client.query("INSERT INTO conversation_proof_attachments(proof_request_id,conversation_id,uploaded_by_user_id,storage_key,content_type,byte_size,submission_note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING proof_attachment_id,content_type,byte_size,uploaded_at,submission_note",[rid,r.conversation_id,req.user.userId,key,actual,b.length,note]);
    await client.query("UPDATE conversation_proof_requests SET request_status='SUBMITTED',updated_at=NOW() WHERE proof_request_id=$1",[rid]);
    await createNotification(client,r.requester_user_id,"PROOF_SUBMITTED","PROOF_REQUEST",rid);
    await client.query("INSERT INTO audit_logs(actor_user_id,action_type,entity_type,entity_id,metadata) VALUES($1,'CHAT_PROOF_SUBMITTED','PROOF_REQUEST',$2,'{}')",[req.user.userId,rid]);
    await client.query("COMMIT");res.status(201).json({attachment:{attachmentId:+a.rows[0].proof_attachment_id,contentType:actual,byteSize:b.length,uploadedAt:a.rows[0].uploaded_at,note}});
  }catch(e){if(client)try{await client.query("ROLLBACK")}catch{}if(filePath)try{await fs12.unlink(filePath)}catch{}console.error("Upload chat proof failed:",e.message);res.status(500).json({error:"Unable to upload proof"});}finally{client?.release();}
});

router.get("/proof-attachments/:attachmentId/content",async(req,res)=>{
 const aid=parseClaimId(req.params.attachmentId);if(!aid)return res.status(400).json({error:"Invalid attachment ID"});
 try{const q=await pool.query("SELECT a.storage_key,a.content_type,a.byte_size,v.claim_id,r.requester_user_id,r.recipient_user_id FROM conversation_proof_attachments a JOIN conversation_proof_requests r USING(proof_request_id) JOIN conversations v ON v.conversation_id=a.conversation_id WHERE a.proof_attachment_id=$1",[aid]);
  if(!q.rowCount)return res.status(404).json({error:"Attachment not found"});const r=q.rows[0],c=await loadContext(pool,r.claim_id,req.user.userId);
  const allowed=c&&(+r.recipient_user_id===+req.user.userId||(+r.requester_user_id===+req.user.userId&&["FINDER","AUTHORITY"].includes(c.side)));
  if(!allowed)return res.status(403).json({error:"Attachment unavailable"});
  const file=path12.resolve(privateProofDir12,r.storage_key);if(!file.startsWith(privateProofDir12+path12.sep))return res.status(404).json({error:"Attachment not found"});
  const bytes=await fs12.readFile(file);res.set({"Content-Type":r.content_type,"Content-Length":String(r.byte_size),"Content-Disposition":"attachment","X-Content-Type-Options":"nosniff","Cache-Control":"private, no-store"});res.send(bytes);
 }catch(e){console.error("Retrieve chat proof failed:",e.message);res.status(404).json({error:"Attachment unavailable"});}
});

router.use((error, req, res, next) => {
  if (error?.type === "entity.too.large") return res.status(413).json({ error: "Proof file exceeds the configured size limit" });
  return next(error);
});

module.exports = router;
