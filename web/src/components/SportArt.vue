<script setup>
defineProps({ kind: String })
</script>

<template>
  <svg class="sport-art" viewBox="0 0 320 240" fill="none" aria-hidden="true">
    <g stroke="currentColor" stroke-width="1" opacity=".16">
      <path d="M-40 220 210-30M0 260 260 0M70 260 320 10M140 260 390 10" />
      <circle cx="205" cy="115" r="108" /><circle cx="205" cy="115" r="85" />
    </g>
    <g v-if="kind === 'badminton'" transform="translate(58 -8) rotate(24 150 120)" stroke="currentColor" stroke-width="4">
      <path d="m110 145-33-103q67-35 134 0l-33 103Z" fill="currentColor" fill-opacity=".12" />
      <path d="m110 145 68 0M77 42l101 103M211 42 110 145M110 30l22 115M178 30l-22 115M144 25v120M91 86h106" stroke-width="2" />
      <path d="M110 148h68v17a34 34 0 0 1-68 0Z" fill="currentColor" />
    </g>
    <g v-else-if="kind === 'tennis' || kind === 'pingpong'" transform="rotate(32 190 110)" stroke="currentColor">
      <ellipse cx="187" cy="86" rx="61" ry="74" :fill="kind === 'pingpong' ? 'currentColor' : 'none'" stroke-width="7" />
      <path v-if="kind === 'tennis'" d="M150 29v114m18-127v142m19-148v151m19-145v142m18-129v114M130 60h114M126 80h122M128 100h118M136 120h102M145 40h84M150 140h74" stroke-width="1.5" />
      <path d="M177 161v60h20v-60" fill="currentColor" stroke-width="3" />
      <circle cx="91" cy="144" r="20" fill="currentColor" stroke="none" />
    </g>
    <g v-else-if="['basketball', 'football', 'volleyball'].includes(kind)" transform="rotate(-22 195 115)" stroke="currentColor" stroke-width="4">
      <circle cx="195" cy="115" r="90" fill="currentColor" fill-opacity=".14" />
      <path v-if="kind === 'basketball'" d="M105 115h180M195 25v180M136 48q116 67 0 134M254 48q-116 67 0 134" />
      <template v-else-if="kind === 'football'">
        <path d="m195 75 38 28-15 45h-46l-15-45Z" fill="currentColor" />
        <path d="m195 75 0-50m38 78 47-16m-62 61 30 40m-76-40-30 40m15-85-47-16" />
      </template>
      <path v-else d="M195 115q-45-35-20-88m20 88q50-20 82 36m-82-36q-5 55-68 56M157 34q-25 65 21 94m106-22q-67-40-89 9m20 88q-10-65-57-65" />
    </g>
    <g v-else-if="kind === 'swimming'" stroke="currentColor" stroke-width="10" stroke-linecap="round">
      <circle cx="230" cy="88" r="20" fill="currentColor" stroke="none" />
      <path d="m123 125 49-63 42 29m-65 11 52 32M70 161q25-24 50 0t50 0t50 0t50 0M70 196q25-24 50 0t50 0t50 0t50 0" />
    </g>
    <g v-else transform="rotate(-28 190 115)" stroke="currentColor" stroke-width="15" stroke-linecap="round">
      <path d="M120 115h140M120 65v100M100 85v60M260 65v100M280 85v60" />
    </g>
  </svg>
</template>
