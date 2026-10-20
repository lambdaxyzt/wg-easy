<template>
  <div class="flex items-center">
    <FormLabel :for="id">
      {{ $t('client.quotaPeriod') }}
    </FormLabel>
    <BaseTooltip :text="$t('client.quotaPeriodDesc')">
      <IconsInfo class="size-4" />
    </BaseTooltip>
  </div>
  <select
    :id="id"
    v-model="period"
    :disabled="disabled"
    class="rounded-lg border-2 border-gray-100 text-gray-500 focus:border-red-800 focus:outline-0 focus:ring-0 disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-700 dark:text-neutral-200"
  >
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
</template>

<script lang="ts" setup>
defineProps<{ id: string; disabled?: boolean }>();

const period = defineModel<'none' | 'day' | 'week' | 'month'>({
  required: true,
});

const { t } = useI18n();

const options = computed(() => [
  { value: 'none', label: t('client.quotaPeriodNone') },
  { value: 'day', label: t('client.quotaPeriodDay') },
  { value: 'week', label: t('client.quotaPeriodWeek') },
  { value: 'month', label: t('client.quotaPeriodMonth') },
]);
</script>
