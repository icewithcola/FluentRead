<template>
  <div class="header-container">
    <div class="logo-area">
      <img src="/logo.png" alt="FluentRead" class="logo" />
      <div class="title-wrapper">
        <h1 class="title">Fluent Read</h1>
        <span class="version">v{{ version }}</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
const version = process.env.VUE_APP_VERSION || '1.0.0'
</script>

<style scoped>
.header-container {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 20px;
  background: var(--fr-card-bg);
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
  margin-bottom: 2px;
  position: sticky;
  top: 0;
  z-index: 100;
  backdrop-filter: blur(10px);
  background-color: rgba(255, 255, 255, 0.85);
}

html.dark .header-container {
  background-color: rgba(37, 37, 37, 0.85);
  box-shadow: 0 1px 2px rgba(0,0,0,0.2);
}

.logo-area {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  width: 32px;
  height: 32px;
  border-radius: 6px;
}

.title-wrapper {
  display: flex;
  flex-direction: column;
  line-height: 1;
}

.title {
  font-size: 18px;
  font-weight: 700;
  margin: 0;
  color: var(--fr-text-color);
  letter-spacing: -0.5px;
}

.version {
  font-size: 11px;
  color: var(--fr-text-secondary);
  margin-top: 2px;
  font-family: monospace;
}
</style>