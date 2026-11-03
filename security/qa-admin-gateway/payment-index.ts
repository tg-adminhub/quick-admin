/**
 * DRAFT ONLY: qa-payment-review Edge entrypoint.
 * Normal payment approval/rejection only; special [device-add] payments are
 * denied until their distinct workflow is audited.
 * No production Supabase DB modification or Edge deployment.
 */
import {handlePaymentReview} from './payment-core.mjs';
import {verifyBearer,protectedRpc} from './edge-operations.ts';

Deno.serve(req=>handlePaymentReview(req,{
  verifyBearer,
  loadAdmin:authUserId=>protectedRpc('qa_svc_admin_profile',{p_auth_user_id:authUserId}),
  executeReview:({authUserId,action,paymentId,expectedStatus,idempotencyKey,approvedAmount,reason})=>
    protectedRpc('qa_svc_payment_review',{
      p_auth_user_id:authUserId,
      p_action:action,
      p_payment_id:paymentId,
      p_expected_status:expectedStatus,
      p_idempotency_key:idempotencyKey,
      p_approved_amount:approvedAmount,
      p_reason:reason
    })
}));
