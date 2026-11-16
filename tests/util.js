let failures = 0;

export function check(ok, what) {
    console.log(`  [${ok ? 'ok' : 'FAIL'}] ${what}`);
    if (!ok) failures++;
}

// distance in seconds from t to the nearest point on the grid phase + k*period
export function gridError(t, phase, period) {
    let x = (t - phase) % period;
    if (x < 0) x += period;
    return Math.min(x, period - x);
}

export function summary() {
    console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
    process.exitCode = failures ? 1 : 0;
}
