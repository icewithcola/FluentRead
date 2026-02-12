<template>
  <div class="popup-container">
    <el-container>
      <el-header class="no-padding" height="auto">
        <Header/>
      </el-header>
      <el-main class="main-content">
        <Main/>
      </el-main>
      <el-footer class="no-padding" height="auto">
        <Footer/>
      </el-footer>
    </el-container>
  </div>
</template>

<script lang="ts" setup>
import Header from '../../components/Header.vue';
import Main from "../../components/Main.vue";
import Footer from "../../components/Footer.vue";
import '../../styles/theme.css';
// Element Plus 基础与暗色变量
import 'element-plus/theme-chalk/base.css';
import 'element-plus/theme-chalk/dark/css-vars.css';

</script>

<style scoped>
.popup-container {
  width: 100%;
  min-height: 100vh;
  background-color: var(--fr-bg-color);
}

.no-padding {
  padding: 0;
}

.main-content {
  padding: 16px;
  overflow-y: auto;
  min-height: 400px;
}

/* Global scrollbar styling for the popup */
::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-thumb {
  background: #ccc;
  border-radius: 3px;
}

::-webkit-scrollbar-track {
  background: transparent;
}
</style>
