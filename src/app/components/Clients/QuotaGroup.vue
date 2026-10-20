<template>
  <FormGroup>
    <FormHeading :description="$t('client.quotaDesc')">
      {{ $t('client.quota') }}
    </FormHeading>
    <FormNullNumberField
      id="quotaLimit"
      v-model="limitGb"
      :label="$t('client.quotaLimit')"
      :description="$t('client.quotaLimitDesc')"
    />
    <div class="flex items-center">
      <FormLabel for="quotaPeriod">
        {{ $t('client.quotaPeriod') }}
      </FormLabel>
      <BaseTooltip :text="$t('client.quotaPeriodDesc')">
        <IconsInfo class="size-4" />
      </BaseTooltip>
    </div>
    <select
      id="quotaPeriod"
      v-model="period"
      :disabled="limitGb === null"
      class="rounded-lg border-2 border-gray-100 text-gray-500 focus:border-red-800 focus:outline-0 focus:ring-0 disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-700 dark:text-neutral-200"
    >
      <option
        v-for="option in periodOptions"
        :key="option.value"
        :value="option.value"
      >
        {{ option.label }}
      </option>
    </select>
    <FormInfoField
      v-if="client.quotaLimit !== null"
      id="quotaUsage"
      :label="$t('client.quotaUsage')"
      :data="usage"
    />
    <FormPrimaryActionField :label="$t('client.quotaSave')" @click="save" />
    <BaseDialog v-if="client.quotaLimit !== null" trigger-class="col-span-2">
      <template #trigger>
        <FormSecondaryActionField
          :label="$t('client.quotaReset')"
          class="inline-block w-full"
          as="span"
        />
      </template>
      <template #title>{{ $t('client.quotaReset') }}</template>
      <template #description>
        <i18n-t keypath="client.quotaResetDialog">
          <template #name>
            <strong>{{ client.name }}</strong>
          </template>
        </i18n-t>
      </template>
      <template #actions>
        <DialogClose as-child>
          <BasePrimaryButton>{{ $t('dialog.cancel') }}</BasePrimaryButton>
        </DialogClose>
        <DialogClose as-child>
          <BaseSecondaryButton @click="reset">
            {{ $t('client.quotaReset') }}
          </BaseSecondaryButton>
        </DialogClose>
      </template>
    </BaseDialog>
  </FormGroup>
</template>

<script lang="ts" setup>
type QuotaPeriod = 'none' | 'day' | 'week' | 'month';

const props = defineProps<{
  client: {
    id: number;
    name: string;
    quotaLimit: number | null;
    quotaPeriod: QuotaPeriod;
    quotaUsed: number;
    quotaExceeded: boolean;
  };
}>();

const emit = defineEmits(['updated']);

const { t } = useI18n();

// GB like the rest of the UI (see `bytes()`)
const GB = 1_000_000_000;

const limitGb = ref<number | null>(null);
const period = ref<QuotaPeriod>('none');

watch(
  () => props.client,
  (client) => {
    limitGb.value = client.quotaLimit === null ? null : client.quotaLimit / GB;
    period.value = client.quotaPeriod;
  },
  { immediate: true }
);

const periodOptions = computed(() => [
  { value: 'none', label: t('client.quotaPeriodNone') },
  { value: 'day', label: t('client.quotaPeriodDay') },
  { value: 'week', label: t('client.quotaPeriodWeek') },
  { value: 'month', label: t('client.quotaPeriodMonth') },
]);

const usage = computed(() => {
  const { quotaUsed, quotaLimit, quotaExceeded } = props.client;
  const text = t('client.quotaUsageValue', {
    used: bytes(quotaUsed),
    limit: bytes(quotaLimit ?? 0),
  });
  return quotaExceeded ? `${text} (${t('client.quotaExceeded')})` : text;
});

const _save = useSubmit(
  (data) =>
    $fetch(`/api/client/${props.client.id}/quota`, {
      method: 'put',
      body: data,
    }),
  {
    revert: async () => {
      emit('updated');
    },
  }
);

function save() {
  const quotaLimit =
    limitGb.value === null ? null : Math.round(limitGb.value * GB);
  return _save({
    quotaLimit,
    quotaPeriod: quotaLimit === null ? 'none' : period.value,
  });
}

const _reset = useSubmit(
  () =>
    $fetch(`/api/client/${props.client.id}/quota/reset`, {
      method: 'post',
    }),
  {
    revert: async () => {
      emit('updated');
    },
  }
);

function reset() {
  return _reset(undefined);
}
</script>
