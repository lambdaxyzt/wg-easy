<template>
  <BaseDialog :trigger-class="triggerClass" @update:open="resetOnOpen">
    <template #trigger>
      <slot />
    </template>
    <template #title>
      {{ $t('client.new') }}
    </template>
    <template #description>
      <div class="flex flex-col">
        <FormTextField id="name" v-model="name" :label="$t('client.name')" />
        <FormDateField
          id="expiresAt"
          v-model="expiresAt"
          :label="$t('client.expireDate')"
        />
        <FormNullNumberField
          id="quotaLimit"
          v-model="quotaLimitGb"
          :label="$t('client.quotaLimit')"
          :description="$t('client.quotaLimitDesc')"
        />
        <ClientsQuotaPeriodField
          id="quotaPeriod"
          v-model="quotaPeriod"
          :disabled="quotaLimitGb === null"
        />
      </div>
    </template>
    <template #actions>
      <DialogClose as-child>
        <BaseSecondaryButton>{{ $t('dialog.cancel') }}</BaseSecondaryButton>
      </DialogClose>
      <DialogClose as-child>
        <BasePrimaryButton @click="createClient">
          {{ $t('client.create') }}
        </BasePrimaryButton>
      </DialogClose>
    </template>
  </BaseDialog>
</template>

<script lang="ts" setup>
const name = ref<string>('');
const expiresAt = ref<string | null>(null);
const quotaLimitGb = ref<number | null>(null);
const quotaPeriod = ref<'none' | 'day' | 'week' | 'month'>('month');
const clientsStore = useClientsStore();

const { t } = useI18n();

// GB like the rest of the UI (see `bytes()`)
const GB = 1_000_000_000;

defineProps<{ triggerClass?: string }>();

function resetOnOpen(open: boolean) {
  if (!open) return;

  name.value = '';
  expiresAt.value = null;
  quotaLimitGb.value = null;
  quotaPeriod.value = 'month';
}

function createClient() {
  const quotaLimit =
    quotaLimitGb.value === null ? null : Math.round(quotaLimitGb.value * GB);
  return _createClient({
    name: name.value,
    expiresAt: expiresAt.value,
    quotaLimit,
    quotaPeriod: quotaLimit === null ? 'none' : quotaPeriod.value,
  });
}

const _createClient = useSubmit(
  (data) =>
    $fetch('/api/client', {
      method: 'post',
      body: data,
    }),
  {
    revert: () => clientsStore.refresh(),
    successMsg: t('client.created'),
  }
);
</script>
