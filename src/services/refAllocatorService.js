export function createRefAllocatorService({ supabase, refStartFloor, getNextRef, setNextRef }) {
  function formatRef(value) {
    return String(value).padStart(6, "0");
  }

  function allocStateRef() {
    const current = Number(getNextRef());
    let nextRef = Number.isFinite(current) ? current + 1 : refStartFloor;

    if (!Number.isFinite(nextRef) || nextRef < refStartFloor) {
      nextRef = refStartFloor;
    }

    setNextRef(nextRef);
    return formatRef(nextRef);
  }

  async function allocSignalRef() {
    if (supabase.ready()) {
      try {
        const current = Number(getNextRef());
        const allocated = await supabase.rpc("next_alert_ref", {
          floor_value: Math.max(refStartFloor, Number.isFinite(current) ? current : refStartFloor),
        });
        const numericRef = Number(allocated);

        if (Number.isFinite(numericRef) && numericRef >= refStartFloor) {
          setNextRef(Math.max(Number(getNextRef()) || refStartFloor, numericRef));
          return formatRef(numericRef);
        }
      } catch (err) {
        console.error("SUPABASE REF ALLOCATOR FAILED - FALLING BACK TO STATE REF:", err?.message || String(err));
      }
    }

    return allocStateRef();
  }

  return {
    allocStateRef,
    allocSignalRef,
  };
}
