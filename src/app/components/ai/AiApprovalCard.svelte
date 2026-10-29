<script lang="ts">
  import type { ApprovalDecision, ApprovalRequest } from '../../../lib/assistant/approval';
  import { t } from '../../i18n';

  export let request: ApprovalRequest;
  export let onDecide: (decision: ApprovalDecision) => void;
</script>

<div class="ai-approval" role="alertdialog" aria-live="assertive">
  <p class="ai-approval-title">{t.aiApprovalTitle()}</p>
  <p class="ai-approval-summary">{request.title}</p>
  {#if request.detail}
    <pre class="ai-approval-detail">{request.detail}</pre>
  {/if}
  <div class="ai-approval-actions">
    <button type="button" class="ai-secondary-button" on:click={() => onDecide('deny')}>
      {t.aiDeny()}
    </button>
    <button type="button" class="ai-primary-button" on:click={() => onDecide('approve')}>
      {t.aiApprove()}
    </button>
  </div>
</div>
