/**
 * DRAFT ONLY: qa-member-maintenance Edge entrypoint.
 * Requires reviewed private admin mapping and service-only SQL in a separate
 * verified environment. Not installed/deployed on production Supabase.
 */
import {handleMemberMaintenance} from './maintenance-core.mjs';
import {verifyBearer,protectedRpc} from './edge-operations.ts';

Deno.serve(req=>handleMemberMaintenance(req,{
  verifyBearer,
  loadAdmin:authUserId=>protectedRpc('qa_svc_admin_profile',{p_auth_user_id:authUserId}),
  executeMutation:({authUserId,action,memberId,deviceId,expectedState,idempotencyKey})=>
    protectedRpc('qa_svc_member_maintenance',{
      p_auth_user_id:authUserId,
      p_action:action,
      p_member_id:memberId,
      p_device_id:deviceId,
      p_expected_state:expectedState,
      p_idempotency_key:idempotencyKey
    })
}));
