//! Platform process-tree ownership.
//!
//! On Windows, each spawned service gets its own Win32 Job Object configured with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When the service is killed, exits
//! (dropping the `ProcessTreeHandle`), or `linkrpc-proc-host` itself terminates,
//! the Windows kernel closes the Job handle and terminates every descendant
//! process (including orphaned grandchildren holding listening sockets).
//!
//! On Unix, children are spawned in their own process group (`process_group(0)`)
//! and signalled via `kill(-pid, sig)`.

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};

    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[repr(C)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(lp_job_attributes: *mut c_void, lp_name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            h_job: *mut c_void,
            info_class: i32,
            lp_info: *const c_void,
            cb_info_len: u32,
        ) -> i32;
        fn OpenProcess(
            dw_desired_access: u32,
            b_inherit_handle: i32,
            dw_process_id: u32,
        ) -> *mut c_void;
        fn AssignProcessToJobObject(h_job: *mut c_void, h_process: *mut c_void) -> i32;
        fn TerminateJobObject(h_job: *mut c_void, u_exit_code: u32) -> i32;
        fn CloseHandle(h_object: *mut c_void) -> i32;
    }

    pub struct ProcessTreeHandle {
        job: *mut c_void,
        pid: u32,
    }

    // Win32 Job handles are thread-safe kernel handles.
    unsafe impl Send for ProcessTreeHandle {}
    unsafe impl Sync for ProcessTreeHandle {}

    impl ProcessTreeHandle {
        pub fn attach(pid: u32) -> Self {
            let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
            if job.is_null() {
                return Self {
                    job: std::ptr::null_mut(),
                    pid,
                };
            }
            let mut info: JobObjectExtendedLimitInformation = unsafe { zeroed() };
            info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set_ok = unsafe {
                SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    (&info as *const JobObjectExtendedLimitInformation).cast::<c_void>(),
                    size_of::<JobObjectExtendedLimitInformation>() as u32,
                )
            };
            if set_ok == 0 {
                unsafe { CloseHandle(job) };
                return Self {
                    job: std::ptr::null_mut(),
                    pid,
                };
            }
            let proc = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
            if proc.is_null() {
                unsafe { CloseHandle(job) };
                return Self {
                    job: std::ptr::null_mut(),
                    pid,
                };
            }
            let assign_ok = unsafe { AssignProcessToJobObject(job, proc) };
            unsafe { CloseHandle(proc) };
            if assign_ok == 0 {
                unsafe { CloseHandle(job) };
                return Self {
                    job: std::ptr::null_mut(),
                    pid,
                };
            }
            Self { job, pid }
        }

        pub fn signal(&self, signal: &str) {
            if signal == "SIGKILL" {
                self.kill();
            }
        }

        pub fn kill(&self) {
            if !self.job.is_null() {
                unsafe {
                    TerminateJobObject(self.job, 1);
                }
            } else {
                let _ = std::process::Command::new("taskkill.exe")
                    .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                    .status();
            }
        }
    }

    impl Drop for ProcessTreeHandle {
        fn drop(&mut self) {
            if !self.job.is_null() {
                unsafe {
                    CloseHandle(self.job);
                }
                self.job = std::ptr::null_mut();
            }
        }
    }
}

#[cfg(unix)]
mod platform {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    pub struct ProcessTreeHandle {
        pid: u32,
    }

    impl ProcessTreeHandle {
        pub fn attach(pid: u32) -> Self {
            Self { pid }
        }

        pub fn signal(&self, signal: &str) {
            let sig = match signal {
                "SIGINT" => 2,
                "SIGQUIT" => 3,
                "SIGKILL" => 9,
                "SIGTERM" => 15,
                "SIGHUP" => 1,
                _ => 15,
            };
            let pgid = -(self.pid as i32);
            unsafe {
                if kill(pgid, sig) != 0 {
                    kill(self.pid as i32, sig);
                }
            }
        }

        pub fn kill(&self) {
            self.signal("SIGKILL");
        }
    }
}

pub use platform::ProcessTreeHandle;
