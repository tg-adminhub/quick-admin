/**
 * QUICK ADMIN config Edge adapter — DRAFT ONLY / NOT DEPLOYED.
 * Requires a service-only RPC with reviewed grants, freshly verified Auth
 * identity, and a private enrolled admin mapping.
 */
import {handleAdminConfig} from './config-core.mjs';
import {verifyBearer,protectedRpc} from './edge-operations.ts';

Deno.serve(req=>handleAdminConfig(req,{
  verifyBearer,
  loadAdmin:authUserId=>protectedRpc('qa_svc_admin_profile',{
    p_auth_user_id:authUserId
  }),
  executeConfig:({authUserId,action,branchId,adminId,key,expectedName,
    newName,expectedValue,newValue,idempotencyKey})=>
    protectedRpc('qa_svc_admin_config',{
      p_auth_user_id:authUserId,
      p_action:action,
      p_branch_id:branchId??null,
      p_admin_id:adminId??null,
      p_setting_key:key??null,
      p_expected:expectedName??expectedValue,
      p_new:newName??newValue,
      p_idempotency_key:idempotencyKey
    })
}));
