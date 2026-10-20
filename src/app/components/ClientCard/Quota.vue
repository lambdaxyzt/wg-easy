<template>
  <div
    v-if="client.quotaLimit !== null"
    class="block text-xs text-gray-500 dark:text-neutral-400"
  >
    <span class="inline-block">
      {{
        $t('client.quotaUsageValue', {
          used: bytes(client.quotaUsed),
          limit: bytes(client.quotaLimit),
        })
      }}
    </span>
    <span
      v-if="client.quotaExceeded"
      class="ml-1 inline-block font-semibold text-red-800 dark:text-red-400"
    >
      {{ $t('client.quotaExceeded') }}
    </span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ client: LocalClient }>();
</script>
